/**
 * Sports Agent — Kalshi-first approach.
 * 1. Pull open sports/crypto markets directly from Kalshi
 * 2. Enrich with ESPN team stats/records as context
 * 3. Claude finds mispriced odds
 */
const Anthropic    = require("@anthropic-ai/sdk");
const kalshi       = require("../kalshi/client");
const espn         = require("../espn/client");
const cryptoClient = require("../crypto/client");
const fs           = require("fs");
const path         = require("path");

const STATE_PATH = path.join(__dirname, "../state.json");
const anthropic  = new Anthropic();

const DEFAULT_STATE = { markets: [], signals: [], positions: [], portfolio: {}, positionAssessments: [], lastUpdated: {}, status: {} };

function readState()  { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { ...DEFAULT_STATE }; } }
function writeState(updates) {
  const cur = readState();
  fs.writeFileSync(STATE_PATH, JSON.stringify(
    { ...cur, ...updates, lastUpdated: { ...cur.lastUpdated, sports: new Date().toISOString() } }, null, 2
  ));
}

// Broad keyword filter — catch any Kalshi market that smells like sports
const SPORTS_RE = /\b(nfl|nba|mlb|mls|epl|premier|champions league|la liga|bundesliga|soccer|football|basketball|baseball|tennis|atp|wta|wimbledon|us open|roland garros|super bowl|world series|finals|championship|playoff|series|match|game|inning|quarter|half|set \d|bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|crypto)\b/i;

async function fetchKalshiSportsMarkets() {
  try {
    // Fetch up to 500 open markets (paginate if needed)
    const pages = await Promise.all([
      kalshi.getMarkets({ limit: 200, status: "open", cursor: undefined }),
      kalshi.getMarkets({ limit: 200, status: "open", page_size: 200, page_number: 2 }),
    ]);
    const all = [
      ...(pages[0].markets ?? []),
      ...(pages[1].markets ?? []),
    ];
    const filtered = all.filter(m => SPORTS_RE.test(m.title ?? ""));
    console.log(`[Sports] ${filtered.length} sports/crypto markets found on Kalshi (from ${all.length} total open)`);
    return filtered;
  } catch (err) {
    console.error("[Sports] Kalshi fetch failed:", err.message);
    return [];
  }
}

const ANALYSIS_PROMPT = `You are a sports and crypto trading agent analyzing Kalshi prediction markets.

You have:
1. Open Kalshi markets with current YES/NO prices
2. ESPN context: today's game schedule, live scores, and cumulative team records/stats for each sport
3. (Optional) Live crypto prices

Your job: find markets where Kalshi's implied probability is meaningfully wrong.

HOW TO ANALYZE:
- Match each Kalshi market to the relevant ESPN game or team using team names, abbreviations, or player names
- Use ESPN team records (e.g. "24-8") and game context (live score, time remaining) to estimate true win probability
- For crypto markets: use current price vs strike price and time to resolution
- For futures/series markets: use standings, records, season performance

SIGNAL CRITERIA (strict — bad trades destroy capital):
- Mispricing > 8%: |fair_prob - market_prob| > 0.08
- Positive EV > 0.03
- Medium or high confidence only
- Skip markets with < 5 minutes remaining or expiring within 10 min for crypto

COMMON EDGES TO LOOK FOR:
- Team with strong record heavily favored but Kalshi pricing is too close to 50/50
- Live game: team up big with little time left but NO is still priced high
- Crypto: price clearly above/below strike with hours remaining but market hasn't repriced

Return ONLY a JSON array, nothing else:
[{
  "ticker": string,
  "title": string,
  "side": "yes" | "no",
  "fair_prob": number,      // decimal 0.0–1.0 (e.g. 0.78 not 78)
  "market_prob": number,    // decimal 0.0–1.0
  "entry_price": number,    // decimal 0.0–1.0 — the ask price to pay (e.g. 0.44 not 44)
  "ev": number,             // decimal (e.g. 0.12)
  "confidence": "high" | "medium" | "low",
  "rationale": string
}]

Return [] if no strong signals. Omit low-confidence entirely.`;

async function run(enabledLeagues) {
  console.log(`[Sports] Scanning — enabled: ${enabledLeagues.join(", ")}`);

  // 1. Pull open markets directly from Kalshi
  const kalshiMarkets = await fetchKalshiSportsMarkets();
  if (kalshiMarkets.length === 0) {
    writeState({ sportsGames: [], sportsSignals: [], cryptoSignals: [] });
    return { signals: [] };
  }

  // 2. Fetch ESPN context (team stats, schedules, live scores) concurrently with crypto prices
  const [espnContext, cryptoPrices] = await Promise.all([
    espn.getContextForLeagues(enabledLeagues),
    enabledLeagues.includes("crypto") ? cryptoClient.getPrices().catch(() => []) : Promise.resolve([]),
  ]);

  if (cryptoPrices.length > 0) {
    console.log(`[Sports/Crypto] Prices: ${cryptoPrices.map(p => `${p.symbol}=$${p.price.toLocaleString()}`).join(" | ")}`);
  }

  // 3. Build payload for Claude
  const payload = {
    kalshi_markets: kalshiMarkets.map(m => ({
      ticker:        m.ticker,
      title:         m.title,
      yes_bid_cents: m.yes_bid  ?? 0,
      yes_ask_cents: m.yes_ask  ?? 0,
      no_bid_cents:  m.no_bid   ?? 0,
      no_ask_cents:  m.no_ask   ?? 0,
      market_prob:   parseFloat((((m.yes_bid ?? 0) + (m.yes_ask ?? 0)) / 2 / 100).toFixed(4)),
      close_time:    m.close_time ?? m.expiration_time ?? null,
    })),
    espn_context: espnContext,
    crypto_prices: cryptoPrices,
  };

  // 4. Claude analysis
  let signals = [];
  try {
    const res = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 3000,
      messages:   [{ role: "user", content: `${ANALYSIS_PROMPT}\n\n${JSON.stringify(payload)}` }],
    });
    const raw    = res.content[0].text.trim();
    const now    = new Date().toISOString();
    const parsed = JSON.parse(raw);

    // Normalise and validate signals so Vault accepts them
    const titleMap = Object.fromEntries(kalshiMarkets.map(m => [m.ticker, m.title]));
    signals = parsed
      .map(s => {
        // entry_price must be 0–1 fraction — Claude sometimes returns cents (e.g. 44 instead of 0.44)
        let ep = parseFloat(s.entry_price ?? 0);
        if (ep > 1) ep = ep / 100;
        return {
          ...s,
          entry_price:   parseFloat(ep.toFixed(4)),
          fair_prob:     parseFloat((s.fair_prob ?? 0).toFixed(4)),
          market_prob:   parseFloat((s.market_prob ?? 0).toFixed(4)),
          ev:            parseFloat((s.ev ?? 0).toFixed(4)),
          title:         s.title ?? titleMap[s.ticker] ?? s.ticker,
          generated_at:  now,    // required by Vault's staleness check
        };
      })
      .filter(s =>
        s.confidence !== "low" &&
        s.ev > 0.03 &&
        Math.abs(s.fair_prob - s.market_prob) > 0.08 &&
        s.entry_price > 0 && s.entry_price < 1  // Vault hard-rejects outside this range
      );
  } catch (err) {
    console.error("[Sports] Analysis failed:", err.message);
  }

  console.log(`[Sports] ${signals.length} actionable signal(s)`);
  signals.forEach(s =>
    console.log(`[Sports]  → ${s.ticker} ${s.side.toUpperCase()} | fair=${(s.fair_prob * 100).toFixed(1)}% mkt=${(s.market_prob * 100).toFixed(1)}% EV=${s.ev.toFixed(3)} | ${s.rationale}`)
  );

  // 5. Merge into state for Vault
  const state           = readState();
  const existingTickers = new Set((state.signals ?? []).map(s => s.ticker));
  const deduped         = signals.filter(s => !existingTickers.has(s.ticker));
  const mergedSignals   = [...(state.signals ?? []), ...deduped];

  const espnGames = Object.values(espnContext).flatMap(ctx => ctx.games ?? []);
  writeState({ sportsGames: espnGames, sportsSignals: signals, signals: mergedSignals });

  return { games: espnGames.length, signals };
}

module.exports = { run };
