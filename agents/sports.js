/**
 * Sports Agent — matches live ESPN games to Kalshi markets and finds mispriced odds.
 * Runs every 30s when enabled. Feeds signals directly to Vault.
 */
const Anthropic = require("@anthropic-ai/sdk");
const kalshi    = require("../kalshi/client");
const espn      = require("../espn/client");
const cryptoClient = require("../crypto/client");
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

const CRYPTO_PROMPT = `You are analyzing Kalshi prediction markets about cryptocurrency prices.

You have live prices for BTC, ETH, SOL, XRP, DOGE, BNB, ADA and a list of open Kalshi markets.

For each crypto market, determine:
1. Which coin it refers to and what the strike/threshold is
2. The true probability given current price, time to resolution, and typical volatility:
   - BTC/ETH: ~3-5% daily vol, ~0.7% hourly
   - SOL/XRP/others: ~5-8% daily vol
3. Whether Kalshi's price is meaningfully wrong

Signal criteria (strict):
- |fair_prob - market_prob| > 0.08  (8%+ mispricing)
- EV > 0.03
- High or medium confidence only
- Skip markets expiring in < 10 minutes (too little edge time)

Example: BTC at $105,200, market asks "above $103,000 by EOD (8 hrs away)" → ~92% probability. If YES is at 75¢, EV = 0.92 - 0.75 = 0.17, strong buy.

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

Return [] if no strong signals.`;

async function fetchCryptoMarkets() {
  try {
    const data = await kalshi.getMarkets({ limit: 100, status: "open" });
    return (data.markets ?? []).filter(m => {
      const title = (m.title ?? "").toLowerCase();
      return /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|doge|dogecoin|bnb|cardano|ada|crypto|coin)\b/.test(title);
    });
  } catch (err) {
    console.error("[Sports/Crypto] Failed to fetch Kalshi markets:", err.message);
    return [];
  }
}

async function runCrypto() {
  console.log("[Sports/Crypto] Fetching live crypto prices…");
  let prices;
  try {
    prices = await cryptoClient.getPrices();
  } catch (err) {
    console.error("[Sports/Crypto] CoinGecko failed:", err.message);
    return [];
  }
  console.log("[Sports/Crypto] Prices: " + prices.map(p => `${p.symbol}=$${p.price.toLocaleString()}`).join(" | "));

  const cryptoMarkets = await fetchCryptoMarkets();
  if (cryptoMarkets.length === 0) {
    console.log("[Sports/Crypto] No crypto markets open on Kalshi");
    return [];
  }
  console.log(`[Sports/Crypto] ${cryptoMarkets.length} crypto markets to analyze`);

  const payload = {
    live_prices: prices,
    markets: cryptoMarkets.map(m => ({
      ticker:        m.ticker,
      title:         m.title,
      yes_bid_cents: m.yes_bid  ?? 0,
      yes_ask_cents: m.yes_ask  ?? 0,
      no_bid_cents:  m.no_bid   ?? 0,
      no_ask_cents:  m.no_ask   ?? 0,
      market_prob:   parseFloat(((( m.yes_bid ?? 0) + (m.yes_ask ?? 0)) / 2 / 100).toFixed(4)),
      close_time:    m.close_time ?? m.expiration_time ?? null,
    })),
  };

  let signals = [];
  try {
    const res = await anthropic.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 2048,
      messages:   [{ role: "user", content: `${CRYPTO_PROMPT}\n\n${JSON.stringify(payload)}` }],
    });
    const raw = res.content[0].text.trim();
    signals   = JSON.parse(raw).filter(s =>
      s.confidence !== "low" && s.ev > 0.03 && Math.abs(s.fair_prob - s.market_prob) > 0.08
    );
  } catch (err) {
    console.error("[Sports/Crypto] Analysis failed:", err.message);
  }

  console.log(`[Sports/Crypto] ${signals.length} crypto signal(s)`);
  signals.forEach(s =>
    console.log(`[Sports/Crypto]  → ${s.ticker} ${s.side.toUpperCase()} | fair=${(s.fair_prob*100).toFixed(1)}% mkt=${(s.market_prob*100).toFixed(1)}% EV=${s.ev.toFixed(3)} | ${s.rationale}`)
  );

  return signals;
}

async function run(enabledLeagues) {
  console.log(`[Sports] Scanning live games — leagues: ${enabledLeagues.join(", ")}`);

  // 1. Fetch live ESPN games (crypto-only mode skips ESPN entirely)
  const espnLeagues = enabledLeagues.filter(k => k !== "crypto");
  const liveGames   = espnLeagues.length > 0 ? await espn.getLiveGames(espnLeagues) : [];
  if (liveGames.length === 0 && !enabledLeagues.includes("crypto")) {
    console.log("[Sports] No live games right now");
    writeState({ sportsGames: [], sportsSignals: [] });
    return { games: 0, signals: [] };
  }
  console.log(`[Sports] ${liveGames.length} live game(s): ${liveGames.map(g => g.summary).join(" | ")}`);

  // 2. Fetch sports-related Kalshi markets (only if ESPN leagues are enabled)
  const sportsMarkets = liveGames.length > 0 ? await fetchSportsMarkets() : [];
  if (sportsMarkets.length === 0 && liveGames.length > 0) {
    console.log("[Sports] No sports markets open on Kalshi right now");
  }
  console.log(`[Sports] ${sportsMarkets.length} potential Kalshi sports markets`);

  // 3. Match markets to live games using Claude (only when both sides exist)
  let matches = [];
  if (liveGames.length > 0 && sportsMarkets.length > 0) {
    const matchPayload = {
      markets: sportsMarkets.map(m => ({ ticker: m.ticker, title: m.title })),
      games:   liveGames.map(g => ({ gameId: g.gameId, name: g.name, summary: g.summary })),
    };
    try {
      const matchRes = await anthropic.messages.create({
        model:      "claude-sonnet-4-6",
        max_tokens: 1024,
        messages:   [{ role: "user", content: `${MATCH_PROMPT}\n\n${JSON.stringify(matchPayload)}` }],
      });
      matches = JSON.parse(matchRes.content[0].text.trim());
    } catch (err) {
      console.error("[Sports] Match step failed:", err.message);
    }
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

  // Run crypto analysis if enabled
  let cryptoSignals = [];
  if (enabledLeagues.includes("crypto")) {
    cryptoSignals = await runCrypto();
  }

  const allNewSignals = [...signals, ...cryptoSignals];

  // Merge into state so Vault can pick them up
  const state           = readState();
  const existingTickers = new Set((state.signals ?? []).map(s => s.ticker));
  const deduped         = allNewSignals.filter(s => !existingTickers.has(s.ticker));
  const mergedSignals   = [...(state.signals ?? []), ...deduped];

  writeState({ sportsGames: liveGames, sportsSignals: signals, cryptoSignals, signals: mergedSignals });

  return { games: liveGames.length, signals: allNewSignals };
}

module.exports = { run };
