/**
 * Scout Agent — discovers and monitors Kalshi markets, surfaces candidates
 * worth analyzing. Uses persistent memory so only new or repriced markets are
 * sent to Claude. Also reassesses open positions on every run.
 */
const Anthropic = require("@anthropic-ai/sdk");
const kalshi = require("../kalshi/client");
const fs = require("fs");
const path = require("path");

const STATE_PATH  = path.join(__dirname, "../state.json");
const MEMORY_PATH = path.join(__dirname, "../scout_memory.json");
const anthropic   = new Anthropic();

// Re-analyze a market if it is older than 10 min OR its mid price moved >2 %
const MEMORY_TTL_MS        = 10 * 60 * 1000;
const PRICE_MOVE_THRESHOLD = 0.02;
const MEMORY_MAX_AGE_MS    = 3  * 60 * 60 * 1000; // prune entries older than 3 h

// Stable system prompts — cached at the API level on repeated calls
const MARKET_SYSTEM_PROMPT = `You are Scout, a market research agent for a Kalshi prediction market trading platform.
Analyze a list of open markets and identify the most promising candidates for trading based on:
- Time to resolution: STRONGLY prefer markets closing TODAY or within 24 hours — fast resolution = fast profit
- Liquidity (volume, open interest)
- Mispricing potential (spread width, implied vs. fair probability)
- Event clarity (well-defined resolution criteria)

PRIORITIZE in this order:
1. Markets closing within 6 hours (highest priority — live events, intraday)
2. Markets closing today / within 24 hours
3. Markets closing within 3 days (acceptable)
4. Markets closing in 3-30 days (low priority only if clearly mispriced)

Return a JSON array — nothing else:
[{ "ticker": string, "title": string, "priority": "high"|"medium"|"low", "reason": string }]

Only include markets worth deeper analysis. Skip anything where you have no informational edge.`;

const POSITION_SYSTEM_PROMPT = `You are Scout, revisiting open Kalshi prediction market positions.
For each position, assess if the thesis is still valid given the current market price.

Return a JSON array — nothing else:
[
  {
    "ticker": string,
    "thesis_valid": boolean,
    "urgency": "hold" | "monitor" | "exit",
    "reassessment": string
  }
]

"hold"    — thesis intact, continue holding
"monitor" — conditions changed, watch closely but no immediate action needed
"exit"    — thesis clearly broken, recommend selling now`;

// ─── helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_STATE = { markets: [], signals: [], positions: [], portfolio: {}, positionAssessments: [], lastUpdated: {}, status: {} };

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { ...DEFAULT_STATE }; }
}

function writeState(updates) {
  const current = readState();
  const next = { ...current, ...updates, lastUpdated: { ...current.lastUpdated, scout: new Date().toISOString() } };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8")); }
  catch { return {}; }
}

function saveMemory(memory) {
  const cutoff = Date.now() - MEMORY_MAX_AGE_MS;
  const pruned = Object.fromEntries(
    Object.entries(memory).filter(([, v]) => new Date(v.last_analyzed).getTime() > cutoff)
  );
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(pruned, null, 2));
}

function needsReanalysis(market, memory) {
  const mem = memory[market.ticker];
  if (!mem) return true; // never seen

  const age = Date.now() - new Date(mem.last_analyzed).getTime();
  if (age > MEMORY_TTL_MS) return true; // TTL expired

  const mid = (parseFloat(market.yes_bid_dollars || 0) + parseFloat(market.yes_ask_dollars || 0)) / 2;
  const move = mem.last_mid > 0 ? Math.abs(mid - mem.last_mid) / mem.last_mid : 1;
  return move > PRICE_MOVE_THRESHOLD; // price moved enough to warrant fresh eyes
}

// ─── market fetch ─────────────────────────────────────────────────────────────

async function fetchCandidateMarkets() {
  const nowSec     = Math.floor(Date.now() / 1000);
  const in6h       = nowSec + 6  * 3600;
  const in24h      = nowSec + 24 * 3600;
  const in3d       = nowSec + 3  * 86400;

  // Fetch intraday markets (close within 24h) and mid-term (3 days) in parallel
  const [intradayData, midtermData] = await Promise.all([
    kalshi.getMarkets({ min_close_ts: nowSec, max_close_ts: in24h, limit: 200, status: "open" }),
    kalshi.getMarkets({ min_close_ts: in24h,  max_close_ts: in3d,  limit: 100, status: "open" }),
  ]);

  const intraday = intradayData.markets || [];
  const midterm  = midtermData.markets  || [];
  console.log(`[Scout] Intraday (≤24h): ${intraday.length} | Mid-term (1-3d): ${midterm.length}`);

  // Sort each bucket by open interest descending
  const sort = arr => arr.sort((a, b) => parseFloat(b.open_interest_fp || "0") - parseFloat(a.open_interest_fp || "0"));

  // Combine: take top 40 intraday + top 10 mid-term
  const top = [...sort(intraday).slice(0, 40), ...sort(midterm).slice(0, 10)];
  console.log(`[Scout] Shortlisted: ${top.length} (${Math.min(intraday.length,40)} intraday + ${Math.min(midterm.length,10)} mid-term)`);
  return top;
}

// ─── analyze new/repriced markets ─────────────────────────────────────────────

async function analyzeNewMarkets(fresh, memory) {
  if (fresh.length === 0) {
    console.log("[Scout] All shortlisted markets cached — no Claude call needed");
    return [];
  }
  console.log(`[Scout] Sending ${fresh.length} new/repriced markets to Claude...`);

  const summary = fresh.map(m => ({
    ticker: m.ticker, title: m.title,
    yes_bid: m.yes_bid_dollars, yes_ask: m.yes_ask_dollars,
    volume: m.volume_fp, open_interest: m.open_interest_fp,
    close_time: m.close_time,
  }));

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 4096,
    system: [{ type: "text", text: MARKET_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{
      role:    "user",
      content: `Analyze these ${fresh.length} Kalshi markets:\n${JSON.stringify(summary, null, 2)}\n\nWhich should we trade?`,
    }],
  });

  const raw = message.content[0]?.text ?? "";
  console.log("[Scout] Market analysis:\n", raw);

  let candidates = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) candidates = JSON.parse(match[0]);
  } catch {
    console.warn("[Scout] Could not parse market analysis");
  }

  // Write every fresh market to memory (even low-priority ones, so we skip them next time)
  const now = new Date().toISOString();
  for (const m of fresh) {
    const mid = (parseFloat(m.yes_bid_dollars || 0) + parseFloat(m.yes_ask_dollars || 0)) / 2;
    const hit = candidates.find(c => c.ticker === m.ticker);
    memory[m.ticker] = {
      priority:      hit?.priority ?? "low",
      reason:        hit?.reason   ?? "",
      title:         hit?.title    ?? m.title,
      last_mid:      mid,
      last_analyzed: now,
    };
  }

  return candidates;
}

// ─── reassess open positions ──────────────────────────────────────────────────

async function reassessPositions(openPositions) {
  if (openPositions.length === 0) return [];
  console.log(`[Scout] Reassessing ${openPositions.length} open position(s)...`);

  // Fetch live market data for each position in parallel
  const enriched = await Promise.all(
    openPositions.map(async pos => {
      const ticker  = pos.ticker || pos.market_ticker;
      const posFp   = parseFloat(pos.position_fp ?? "0");
      const count   = Math.round(Math.abs(posFp));
      const side    = posFp > 0 ? "yes" : "no";
      const paid    = parseFloat(pos.total_traded_dollars ?? "0");
      const avgEntry = count > 0 ? paid / count : 0;

      try {
        const market = await kalshi.getMarket(ticker);
        const bid = parseFloat(market.yes_bid_dollars ?? 0);
        const ask = parseFloat(market.yes_ask_dollars ?? 0);
        const exitVal = side === "yes" ? bid : (1 - ask);
        const gainPct = avgEntry > 0 ? ((exitVal - avgEntry) / avgEntry * 100).toFixed(1) : "0";
        const daysLeft = Math.max(0, (new Date(market.close_time).getTime() - Date.now()) / 86_400_000);

        return {
          ticker,
          title:         market.title,
          side,
          contracts:     count,
          avg_entry:     parseFloat(avgEntry.toFixed(3)),
          current_bid:   bid,
          current_ask:   ask,
          gain_loss_pct: parseFloat(gainPct),
          days_to_close: parseFloat(daysLeft.toFixed(1)),
        };
      } catch (err) {
        console.warn(`[Scout] Cannot fetch data for ${ticker}: ${err.message}`);
        return null;
      }
    })
  );

  const valid = enriched.filter(Boolean);
  if (valid.length === 0) return [];

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: POSITION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{
      role:    "user",
      content: `Reassess these held positions:\n${JSON.stringify(valid, null, 2)}`,
    }],
  });

  const raw = message.content[0]?.text ?? "";
  console.log("[Scout] Position reassessment:\n", raw);

  let assessments = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) assessments = JSON.parse(match[0]);
  } catch {
    console.warn("[Scout] Could not parse position reassessment");
  }

  return assessments.map(a => ({ ...a, assessed_at: new Date().toISOString() }));
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log("[Scout] Starting market scan...");
  const state = readState();
  writeState({ status: { ...state.status, scout: "running" } });

  try {
    const [markets, balanceData] = await Promise.all([
      fetchCandidateMarkets(),
      kalshi.getBalance(),
    ]);

    const balance = balanceData.balance ?? balanceData.available_balance ?? 0;
    console.log(`[Scout] Balance: $${(balance / 100).toFixed(2)}`);

    const memory = loadMemory();

    // Partition: fresh markets need Claude, cached markets reuse memory
    const fresh  = markets.filter(m =>  needsReanalysis(m, memory));
    const cached = markets.filter(m => !needsReanalysis(m, memory));
    console.log(`[Scout] Fresh: ${fresh.length} | Cached: ${cached.length}`);
    markets.slice(0, 5).forEach(m =>
      console.log(`  ${m.ticker} | oi=${m.open_interest_fp}${needsReanalysis(m, memory) ? "" : " [cached]"}`)
    );

    // Run market analysis and position reassessment concurrently
    const openPositions = (state.positions || []).filter(p => parseFloat(p.position_fp ?? "0") !== 0);

    const [freshCandidates, positionAssessments] = await Promise.all([
      analyzeNewMarkets(fresh, memory),
      reassessPositions(openPositions),
    ]);

    // Merge fresh results with high/medium memory entries
    const cachedCandidates = cached
      .filter(m => memory[m.ticker]?.priority && memory[m.ticker].priority !== "low")
      .map(m => ({
        ticker:   m.ticker,
        title:    memory[m.ticker].title || m.title,
        priority: memory[m.ticker].priority,
        reason:   memory[m.ticker].reason + " [memory]",
      }));

    const allCandidates = [...freshCandidates, ...cachedCandidates];

    if (positionAssessments.length > 0) {
      console.log("[Scout] Position assessments:");
      positionAssessments.forEach(a =>
        console.log(`  ${a.ticker} → ${a.urgency.toUpperCase()}: ${a.reassessment}`)
      );
    }

    saveMemory(memory);

    writeState({
      markets:             allCandidates,
      positionAssessments,
      portfolio:           { ...readState().portfolio, balance },
      status:              { ...state.status, scout: "idle" },
    });

    console.log(`[Scout] Done — ${allCandidates.length} candidates (${freshCandidates.length} fresh + ${cachedCandidates.length} from memory), ${positionAssessments.length} position(s) assessed`);
    return allCandidates;
  } catch (err) {
    writeState({ status: { ...state.status, scout: "error" } });
    console.error("[Scout] Error:", err.message);
    throw err;
  }
}

module.exports = { run };
