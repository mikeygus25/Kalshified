/**
 * Sports Agent — matches live ESPN games to Kalshi markets and finds mispriced odds.
 * Runs every 30s when enabled. Feeds signals directly to Vault.
 */
const Anthropic = require("@anthropic-ai/sdk");
const kalshi    = require("../kalshi/client");
const espn      = require("../espn/client");
const fs        = require("fs");
const path      = require("path");

const STATE_PATH = path.join(__dirname, "../state.json");
const anthropic  = new Anthropic();

const DEFAULT_STATE = { markets: [], signals: [], positions: [], portfolio: {}, positionAssessments: [], lastUpdated: {}, status: {} };

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { ...DEFAULT_STATE }; }
}

function writeState(updates) {
  const current = readState();
  fs.writeFileSync(STATE_PATH, JSON.stringify(
    { ...current, ...updates, lastUpdated: { ...current.lastUpdated, sports: new Date().toISOString() } },
    null, 2
  ));
}

const MATCH_PROMPT = `You are matching Kalshi prediction market titles to live ESPN sports games.

Given a list of Kalshi market titles and a list of live games, identify which markets clearly relate to which game.

Rules:
- Only match if you are confident the market resolves based on this specific live game
- Skip ambiguous or futures markets (season wins, MVP, etc.)
- Match team names, abbreviations, and common nicknames

Return ONLY a JSON array, nothing else:
[{ "ticker": "<kalshi_ticker>", "gameId": "<espn_game_id>" }]

Return [] if no confident matches.`;

const ANALYSIS_PROMPT = `You are a live sports trading agent for Kalshi prediction markets.

Analyze each matched market+game pair for mispricing. Your job is NOT to predict who wins — it is to find where Kalshi's current odds are mathematically wrong given the live game state.

For each pair, estimate the true win probability based on:
- Score differential and time remaining (most important)
- Sport-specific comeback rates (e.g. NFL: 17+ point deficit with 2 min left is ~2% comeback chance)
- Game flow context

Signal criteria (be strict — false edges destroy capital):
- Mispricing > 8%: |fair_prob - market_prob| > 0.08
- Positive EV > 0.03 after crossing the spread
- At least 3 minutes of game time remaining
- High or medium confidence only

EV formula:
- Buy YES @ ask:  EV = fair_prob - ask_price
- Buy NO  @ ask:  EV = (1 - fair_prob) - (1 - bid_price)

Return ONLY a JSON array, nothing else:
[{
  "ticker": string,
  "side": "yes" | "no",
  "fair_prob": number,
  "market_prob": number,
  "entry_price": number,
  "ev": number,
  "confidence": "high" | "medium" | "low",
  "rationale": string
}]

Return [] if no strong signals. Omit low-confidence signals entirely.`;

async function fetchSportsMarkets() {
  try {
    const data = await kalshi.getMarkets({ limit: 100, status: "open" });
    return (data.markets ?? []).filter(m => {
      const title = (m.title ?? "").toLowerCase();
      // Keep markets that look sports-related by common keywords
      return /\b(nfl|nba|mlb|mls|epl|premier|soccer|football|basketball|baseball|tennis|atp|wta|super bowl|world series|finals|championship|match|game|series|playoff|innings?|quarter|half|set \d)\b/.test(title);
    });
  } catch (err) {
    console.error("[Sports] Failed to fetch Kalshi markets:", err.message);
    return [];
  }
}

async function getLiveMarketData(tickers) {
  const results = {};
  await Promise.allSettled(tickers.map(async ticker => {
    try {
      const m = await kalshi.getMarket(ticker);
      results[ticker] = m;
    } catch {}
  }));
  return results;
}

async function run(enabledLeagues) {
  console.log(`[Sports] Scanning live games — leagues: ${enabledLeagues.join(", ")}`);

  // 1. Fetch live ESPN games
  const liveGames = await espn.getLiveGames(enabledLeagues);
  if (liveGames.length === 0) {
    console.log("[Sports] No live games right now");
    writeState({ sportsGames: [], sportsSignals: [] });
    return { games: 0, signals: [] };
  }
  console.log(`[Sports] ${liveGames.length} live game(s): ${liveGames.map(g => g.summary).join(" | ")}`);

  // 2. Fetch sports-related Kalshi markets
  const sportsMarkets = await fetchSportsMarkets();
  if (sportsMarkets.length === 0) {
    console.log("[Sports] No sports markets open on Kalshi right now");
    writeState({ sportsGames: liveGames, sportsSignals: [] });
    return { games: liveGames.length, signals: [] };
  }
  console.log(`[Sports] ${sportsMarkets.length} potential Kalshi sports markets`);

  // 3. Match markets to live games using Claude
  const matchPayload = {
    markets: sportsMarkets.map(m => ({ ticker: m.ticker, title: m.title })),
    games:   liveGames.map(g => ({ gameId: g.gameId, name: g.name, summary: g.summary })),
  };

  let matches = [];
  try {
    const matchRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 1024,
      messages:   [{ role: "user", content: `${MATCH_PROMPT}\n\n${JSON.stringify(matchPayload)}` }],
    });
    matches = JSON.parse(matchRes.content[0].text.trim());
  } catch (err) {
    console.error("[Sports] Match step failed:", err.message);
    return { games: liveGames.length, signals: [] };
  }

  if (matches.length === 0) {
    console.log("[Sports] No Kalshi markets matched to live games");
    writeState({ sportsGames: liveGames, sportsSignals: [] });
    return { games: liveGames.length, signals: [] };
  }
  console.log(`[Sports] ${matches.length} market-game matches found`);

  // 4. Fetch live order book data for matched markets
  const matchedTickers = matches.map(m => m.ticker);
  const liveData       = await getLiveMarketData(matchedTickers);

  // 5. Build analysis payload
  const analysisItems = matches.map(match => {
    const game   = liveGames.find(g => g.gameId === match.gameId);
    const market = sportsMarkets.find(m => m.ticker === match.ticker);
    const live   = liveData[match.ticker];
    if (!game || !market) return null;

    const yesBid = live?.yes_bid  ?? market.yes_bid  ?? 0;
    const yesAsk = live?.yes_ask  ?? market.yes_ask  ?? 0;
    const noBid  = live?.no_bid   ?? market.no_bid   ?? 0;
    const noAsk  = live?.no_ask   ?? market.no_ask   ?? 0;
    const mid    = (yesBid + yesAsk) / 2 / 100;

    return {
      ticker:       match.ticker,
      title:        market.title,
      yes_bid_cents: yesBid,
      yes_ask_cents: yesAsk,
      no_bid_cents:  noBid,
      no_ask_cents:  noAsk,
      market_prob:   parseFloat(mid.toFixed(4)),
      game: {
        league:      game.leagueLabel,
        summary:     game.summary,
        home:        game.home,
        away:        game.away,
        clock:       game.clock,
        period:      game.periodLabel,
        status:      game.status,
      },
    };
  }).filter(Boolean);

  if (analysisItems.length === 0) {
    return { games: liveGames.length, signals: [] };
  }

  // 6. Send to Claude for EV analysis
  let signals = [];
  try {
    const analysisRes = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 2048,
      messages:   [{ role: "user", content: `${ANALYSIS_PROMPT}\n\n${JSON.stringify(analysisItems)}` }],
    });
    const raw = analysisRes.content[0].text.trim();
    signals   = JSON.parse(raw).filter(s =>
      s.confidence !== "low" && s.ev > 0.03 && Math.abs(s.fair_prob - s.market_prob) > 0.08
    );
  } catch (err) {
    console.error("[Sports] Analysis step failed:", err.message);
  }

  console.log(`[Sports] ${signals.length} actionable signal(s) found`);
  signals.forEach(s =>
    console.log(`[Sports]  → ${s.ticker} ${s.side.toUpperCase()} | fair=${(s.fair_prob*100).toFixed(1)}% mkt=${(s.market_prob*100).toFixed(1)}% EV=${s.ev.toFixed(3)} | ${s.rationale}`)
  );

  // Merge sports signals into state so Vault can pick them up
  const state          = readState();
  const existingTickers = new Set((state.signals ?? []).map(s => s.ticker));
  const newSignals      = signals.filter(s => !existingTickers.has(s.ticker));
  const mergedSignals   = [...(state.signals ?? []), ...newSignals];

  writeState({ sportsGames: liveGames, sportsSignals: signals, signals: mergedSignals });

  return { games: liveGames.length, signals };
}

module.exports = { run };
