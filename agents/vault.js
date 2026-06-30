/**
 * Vault Agent — buys and sells automatically.
 *
 * Each run does two things in order:
 *   1. SELL — scan open positions, close any that hit a trigger
 *   2. BUY  — evaluate Edge signals, size with Kelly, get Claude approval, open new positions
 */
const Anthropic = require("@anthropic-ai/sdk");
const kalshi    = require("../kalshi/client");
const tradeLog  = require("../trade_log");
const telegram  = require("../telegram");
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "../state.json");
const anthropic = new Anthropic();

const MAX_POSITION_CONTRACTS = parseInt(process.env.MAX_POSITION_SIZE || "100", 10);
const MAX_DAILY_LOSS        = parseInt(process.env.MAX_DAILY_LOSS     || "500", 10);
const MAX_OPEN_POSITIONS    = parseInt(process.env.MAX_OPEN_POSITIONS  || "10",  10);
const SIGNAL_MAX_AGE_MS     = 2 * 60 * 60 * 1000; // ignore signals older than 2 h

// Sell triggers (all purely mechanical — no Claude involved)
const TAKE_PROFIT_THRESHOLD = 0.50; // sell when 50 % of max possible gain is captured
const STOP_LOSS_THRESHOLD   = 0.60; // sell when 60 % of entry cost is lost
const TIME_EXIT_DAYS        = 1.0;  // sell when < 1 day to close

const BUY_SYSTEM_PROMPT = `You are Vault, the final risk-management gatekeeper for a Kalshi prediction market trading platform.

You receive proposed buy orders that have already passed hard risk filters and been sized with fractional Kelly criterion.
Do a final sanity check — approve, reduce, or reject each order.

Return a JSON array of approved orders (return [] if nothing should be placed):
[
  {
    "ticker": string,
    "side": "yes" | "no",
    "count": number,        // integer ≥ 1, never exceed the proposed count
    "price_cents": number,  // limit price in cents, integer 1–99
    "rationale": string     // one sentence on the specific edge being captured
  }
]`;

// ─── helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_STATE = { markets: [], signals: [], positions: [], portfolio: {}, positionAssessments: [], lastUpdated: {}, status: {} };

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { ...DEFAULT_STATE }; }
}

function writeState(updates) {
  const current = readState();
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      { ...current, ...updates, lastUpdated: { ...current.lastUpdated, vault: new Date().toISOString() } },
      null,
      2
    )
  );
}

async function syncPortfolio() {
  const [balanceData, positionsData] = await Promise.all([
    kalshi.getBalance(),
    kalshi.getPositions(),
  ]);
  const balance   = balanceData.balance ?? balanceData.available_balance ?? 0;
  const positions = (positionsData.market_positions || []).filter(
    (p) => parseFloat(p.position_fp ?? "0") !== 0
  );
  return { balance, positions };
}

// Quarter-Kelly sizing.  Returns integer contract count ≥ 1, or 0 (no bet).
function kellyContracts(signal, balanceCents) {
  const { fair_prob, entry_price, side } = signal;
  const winProb = side === "yes" ? fair_prob : 1 - fair_prob;
  const kelly   = (winProb - entry_price) / (1 - entry_price);
  if (kelly <= 0) return 0;
  const betDollars = (balanceCents / 100) * kelly * 0.25;
  return Math.min(Math.max(Math.floor(betDollars / entry_price), 1), MAX_POSITION_CONTRACTS);
}

// ─── sell phase ──────────────────────────────────────────────────────────────

async function manageSells(positions, assessmentMap = {}) {
  if (positions.length === 0) return [];

  // Only manage positions the bot itself opened — never touch manually-placed trades
  const botTickers = tradeLog.getBotBuyTickers();

  console.log(`[Vault] Checking ${positions.length} position(s) for sell triggers...`);
  const closed = [];

  for (const pos of positions) {
    const ticker = pos.ticker || pos.market_ticker;
    if (!ticker) continue;

    const positionFp = parseFloat(pos.position_fp ?? "0");
    if (positionFp === 0) continue;

    // Skip positions the bot didn't open
    if (!botTickers.has(ticker)) {
      console.log(`  ${ticker} | SKIPPED — manually placed, bot will not touch`);
      continue;
    }

    const side  = positionFp > 0 ? "yes" : "no";
    const count = Math.round(Math.abs(positionFp));

    try {
      const market = await kalshi.getMarket(ticker);

      // Skip markets that have already settled — positions resolve automatically
      if (market.status && market.status !== "open") {
        console.log(`  ${ticker} | SKIPPED — market status: ${market.status}`);
        continue;
      }

      const yesBid = parseFloat(market.yes_bid_dollars ?? 0);
      const yesAsk = parseFloat(market.yes_ask_dollars ?? 0);

      // Price at which we can exit right now
      const exitPrice = side === "yes" ? yesBid : (1 - yesAsk);

      // Use trade log for accurate avg entry (handles multiple tranches); fall back to Kalshi cost basis
      const logAvgEntry = tradeLog.getPositionAvgEntry(ticker);
      const totalPaid   = parseFloat(pos.total_traded_dollars ?? "0");
      const avgEntry    = logAvgEntry > 0 ? logAvgEntry : (count > 0 ? totalPaid / count : 0);

      const daysLeft      = Math.max(0, (new Date(market.close_time).getTime() - Date.now()) / 86_400_000);
      const gainPctOfMax  = avgEntry < 1 ? (exitPrice - avgEntry) / (1 - avgEntry) : 0;
      const lossPctOfCost = avgEntry > 0 ? (avgEntry - exitPrice) / avgEntry : 0;

      // Live/same-day markets (closes within 6 hours) can swing wildly mid-event.
      // Suppress stop-loss only — thesis_invalidated, take_profit, and time_exit still fire.
      const isLiveEvent = daysLeft < 0.25;

      const assessment = assessmentMap[ticker];
      const status = `entry=$${avgEntry.toFixed(3)} exit=$${exitPrice.toFixed(3)} gain=${(gainPctOfMax * 100).toFixed(0)}% loss=${(lossPctOfCost * 100).toFixed(0)}% days=${daysLeft.toFixed(1)}${isLiveEvent ? " [LIVE]" : ""}`;

      let trigger = null;
      if      (assessment?.urgency === "exit")                        trigger = `thesis_invalidated: ${assessment.reassessment}`;
      else if (gainPctOfMax  >= TAKE_PROFIT_THRESHOLD)                trigger = `take_profit (${(gainPctOfMax * 100).toFixed(0)}% of max gain captured)`;
      else if (lossPctOfCost >= STOP_LOSS_THRESHOLD && !isLiveEvent) trigger = `stop_loss (lost ${(lossPctOfCost * 100).toFixed(0)}% of cost)`;
      else if (daysLeft < TIME_EXIT_DAYS && !isLiveEvent)             trigger = `time_exit (${daysLeft.toFixed(2)} days left)`;

      console.log(`  ${ticker} | ${side.toUpperCase()} ${count}x | ${status}${trigger ? ` → SELL: ${trigger}` : ""}`);

      if (!trigger) continue;

      // Sell at the current best bid for immediate execution
      const sellPriceCents = side === "yes"
        ? Math.round(yesBid * 100)
        : Math.round((1 - yesAsk) * 100);

      if (sellPriceCents < 1 || sellPriceCents > 99) {
        console.warn(`[Vault] Sell price out of range for ${ticker}: ${sellPriceCents}¢ — skipping`);
        continue;
      }

      console.log(`[Vault] SELLING ${side.toUpperCase()} ${count}x ${ticker} @ ${sellPriceCents}¢ (${trigger})`);

      const result = await kalshi.createOrder({
        ticker,
        action: "sell",
        side,
        type:  "limit",
        count,
        ...(side === "yes" ? { yes_price: sellPriceCents } : { no_price: sellPriceCents }),
        client_order_id: `vlt-sell-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      const orderId = result.order?.order_id ?? result.order_id;
      console.log(`[Vault] Sell accepted: ${orderId}`);
      const pnl = (sellPriceCents / 100 - avgEntry) * count;
      tradeLog.logSell({
        ticker, title: market.title, side, count,
        price_cents: sellPriceCents,
        avg_entry_dollars: avgEntry,
        trigger, order_id: orderId,
      });
      telegram.alertSell({ ticker, side, count, price_cents: sellPriceCents, pnl, trigger })
        .catch(() => {});
      closed.push({ ticker, side, count, sellPriceCents, trigger, order_id: orderId });
    } catch (err) {
      console.error(`[Vault] Sell check failed for ${ticker}:`, err.response?.data ?? err.message);
    }
  }

  return closed;
}

// ─── buy phase ───────────────────────────────────────────────────────────────

async function manageBuys(signals, balance, openTickers, openPositionCount) {
  if (signals.length === 0) return [];

  // Portfolio-level hard stops — use live PnL from trade log
  const dailyPnl = tradeLog.getDailyPnl();
  if (dailyPnl <= -MAX_DAILY_LOSS) {
    console.warn(`[Vault] Daily loss limit hit ($${dailyPnl.toFixed(2)}) — no new buys.`);
    return [];
  }
  if (openPositionCount >= MAX_OPEN_POSITIONS) {
    console.warn("[Vault] Max open positions — no new buys.");
    return [];
  }

  const now      = Date.now();
  const proposed = [];

  for (const signal of signals) {
    const age = now - new Date(signal.generated_at || 0).getTime();
    if (age > SIGNAL_MAX_AGE_MS) {
      console.log(`[Vault] Stale signal skipped: ${signal.ticker} (${Math.round(age / 60000)}m old)`);
      continue;
    }
    if (openTickers.has(signal.ticker)) {
      console.log(`[Vault] Already have position in ${signal.ticker} — skipping`);
      continue;
    }
    if (signal.confidence === "low") {
      console.log(`[Vault] Low-confidence signal skipped: ${signal.ticker}`);
      continue;
    }
    if (!signal.entry_price || signal.entry_price <= 0 || signal.entry_price >= 1) {
      console.log(`[Vault] Invalid entry price for ${signal.ticker}: ${signal.entry_price}`);
      continue;
    }

    const contracts = kellyContracts(signal, balance);
    if (contracts === 0) {
      console.log(`[Vault] Kelly sizing zero for ${signal.ticker} — skipping`);
      continue;
    }

    proposed.push({
      ticker:      signal.ticker,
      title:       signal.title,
      side:        signal.side,
      count:       contracts,
      price_cents: Math.round(signal.entry_price * 100),
      fair_prob:   signal.fair_prob,
      market_prob: signal.market_prob,
      ev:          signal.ev,
      confidence:  signal.confidence,
      rationale:   signal.rationale,
    });
  }

  if (proposed.length === 0) {
    console.log("[Vault] No buy signals passed pre-filters.");
    return [];
  }

  console.log(`[Vault] ${proposed.length} proposed buy(s):`);
  proposed.forEach((o) =>
    console.log(`  ${o.ticker} | ${o.side.toUpperCase()} ${o.count}x @ ${o.price_cents}¢ | fair=${o.fair_prob} ev=${o.ev} [${o.confidence}]`)
  );

  // Claude approval
  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 2048,
    system:     BUY_SYSTEM_PROMPT,
    messages: [
      {
        role:    "user",
        content: `Portfolio: balance=$${(balance / 100).toFixed(2)}, open_positions=${openPositionCount}, daily_pnl=$${dailyPnl}\nLimits: max_contracts=${MAX_POSITION_CONTRACTS}, max_positions=${MAX_OPEN_POSITIONS}\n\nProposed orders:\n${JSON.stringify(proposed, null, 2)}\n\nApprove, modify, or reject each.`,
      },
    ],
  });

  const raw = message.content[0]?.text ?? "";
  console.log("[Vault] Claude buy response:\n", raw);

  let approved = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) approved = JSON.parse(match[0]);
  } catch {
    console.warn("[Vault] Could not parse Claude buy response");
  }

  const placed = [];
  for (const order of approved) {
    if (
      !order.ticker ||
      !["yes", "no"].includes(order.side) ||
      !Number.isInteger(order.count) || order.count < 1 ||
      !Number.isInteger(order.price_cents) || order.price_cents < 1 || order.price_cents > 99
    ) {
      console.warn("[Vault] Invalid buy order skipped:", order);
      continue;
    }

    const cap   = proposed.find((p) => p.ticker === order.ticker)?.count ?? order.count;
    const count = Math.min(order.count, cap);

    try {
      console.log(`[Vault] BUYING ${order.side.toUpperCase()} ${count}x ${order.ticker} @ ${order.price_cents}¢ — ${order.rationale}`);

      const result = await kalshi.createOrder({
        ticker: order.ticker,
        action: "buy",
        side:   order.side,
        type:   "limit",
        count,
        ...(order.side === "yes" ? { yes_price: order.price_cents } : { no_price: order.price_cents }),
        client_order_id: `vlt-buy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      const orderId = result.order?.order_id ?? result.order_id;
      console.log(`[Vault] Buy accepted: ${orderId}`);
      tradeLog.logBuy({
        ticker: order.ticker, title: order.title, side: order.side,
        count, price_cents: order.price_cents, order_id: orderId,
      });
      telegram.alertBuy({ ticker: order.ticker, title: order.title, side: order.side, count, price_cents: order.price_cents })
        .catch(() => {});
      placed.push({ ...order, count, order_id: orderId, placed_at: new Date().toISOString() });
    } catch (err) {
      console.error(`[Vault] Buy failed for ${order.ticker}:`, err.response?.data ?? err.message);
    }
  }

  return placed;
}

// ─── main entry point ─────────────────────────────────────────────────────────

async function run() {
  const state   = readState();
  const signals = state.signals || [];

  writeState({ status: { ...state.status, vault: "running" } });

  try {
    const { balance, positions } = await syncPortfolio();
    console.log(`[Vault] Balance: $${(balance / 100).toFixed(2)} | Open positions: ${positions.length}`);

    writeState({
      portfolio: { ...state.portfolio, balance, openPositions: positions.length },
      positions,
    });

    // ── 1. SELL ──────────────────────────────────────────────────────────────
    const assessments = state.positionAssessments || [];
    const assessmentMap = Object.fromEntries(assessments.map(a => [a.ticker, a]));
    const sold = await manageSells(positions, assessmentMap);

    // After selling, remove closed tickers from the open set
    const soldTickers  = new Set(sold.map((s) => s.ticker));
    const openTickers  = new Set(
      positions.map((p) => p.ticker || p.market_ticker).filter((t) => t && !soldTickers.has(t))
    );
    const openCount    = openTickers.size;

    // ── 2. BUY ───────────────────────────────────────────────────────────────
    const placed = signals.length > 0
      ? await manageBuys(signals, balance, openTickers, openCount)
      : (console.log("[Vault] No signals — skipping buy phase."), []);

    writeState({ status: { ...state.status, vault: "idle" } });

    const summary = `sold=${sold.length} bought=${placed.length}`;
    console.log(`[Vault] Done — ${summary}`);
    return { sold, placed };
  } catch (err) {
    writeState({ status: { ...state.status, vault: "error" } });
    console.error("[Vault] Error:", err.message);
    throw err;
  }
}

module.exports = { run };
