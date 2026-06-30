/**
 * Edge Agent — enriches Scout's candidates with live market data and recent news,
 * then uses Claude to estimate fair-value probabilities and compute EV trade signals.
 *
 * News context: set BRAVE_SEARCH_API_KEY in .env for live news on high-priority markets.
 * Free tier: https://api.search.brave.com (2,000 queries/month)
 */
const Anthropic = require("@anthropic-ai/sdk");
const axios    = require("axios");
const kalshi   = require("../kalshi/client");
const fs   = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "../state.json");
const anthropic  = new Anthropic();

// In-memory news cache: { [ticker]: { articles: [], fetched_at: timestamp } }
const newsCache = {};
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `You are Edge, a quantitative analysis agent for a Kalshi prediction market trading platform.
Today's date is ${today}.

Kalshi binary markets pay $1 for YES and $0 for NO. All prices are in dollars (0–1 range).

EV formulas (per dollar risked):
  Buy YES at ask price p:      EV = fair_prob - p
  Buy NO at price (1 - bid):   EV = bid - fair_prob

Generate a signal only when both conditions hold:
  1. |fair_prob - mid_price| > 0.05  (meaningful mispricing)
  2. EV > 0.02 after crossing the spread

Return a JSON array with this exact shape (no extra keys):
[
  {
    "ticker": string,
    "title": string,
    "side": "yes" | "no",
    "fair_prob": number,      // your estimated true probability 0-1
    "market_prob": number,    // mid-price from the market 0-1
    "entry_price": number,    // yes_ask for YES, (1 - yes_bid) for NO
    "ev": number,             // expected value per dollar risked
    "confidence": "high" | "medium" | "low",
    "rationale": string       // 1-2 sentences on the specific edge
  }
]

Return [] if no markets clear the bar. Be rigorous — false edges destroy capital.`;
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function writeState(updates) {
  const current = readState();
  const next = {
    ...current,
    ...updates,
    lastUpdated: { ...current.lastUpdated, edge: new Date().toISOString() },
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

// Fetch recent news for high-priority candidates via Brave Search API.
// Returns { [ticker]: [{title, description, age}] }
async function fetchNewsForCandidates(candidates) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return {};

  const now = Date.now();
  const toFetch = candidates
    .filter(c => c.scout_priority === "high" || c.scout_priority === "medium")
    .slice(0, 4) // max 4 queries per Edge run
    .filter(c => {
      const cached = newsCache[c.ticker];
      return !cached || (now - cached.fetched_at) > NEWS_CACHE_TTL_MS;
    });

  if (toFetch.length === 0) return Object.fromEntries(
    Object.entries(newsCache).map(([t, v]) => [t, v.articles])
  );

  console.log(`[Edge] Fetching news for ${toFetch.length} candidate(s)...`);
  await Promise.all(toFetch.map(async (c) => {
    try {
      const res = await axios.get("https://api.search.brave.com/res/v1/news/search", {
        params: { q: c.title, count: 3, freshness: "pd" },
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
        timeout: 5000,
      });
      const articles = (res.data?.results || []).slice(0, 3).map(a => ({
        title:       a.title,
        description: a.description,
        age:         a.age,
      }));
      newsCache[c.ticker] = { articles, fetched_at: now };
    } catch (err) {
      console.warn(`[Edge] News fetch failed for ${c.ticker}: ${err.message}`);
    }
  }));

  return Object.fromEntries(
    Object.entries(newsCache).map(([t, v]) => [t, v.articles])
  );
}

async function enrichWithLiveData(candidates) {
  const newsMap = await fetchNewsForCandidates(candidates);

  const results = await Promise.all(
    candidates.map(async (c) => {
      try {
        const market = await kalshi.getMarket(c.ticker);
        const bid = parseFloat(market.yes_bid_dollars ?? 0);
        const ask = parseFloat(market.yes_ask_dollars ?? 0);
        const mid = (bid + ask) / 2;
        const daysToClose =
          Math.max(0, (new Date(market.close_time).getTime() - Date.now()) / 86_400_000);

        const enriched = {
          ticker: market.ticker,
          title: market.title,
          scout_priority: c.priority,
          scout_reason: c.reason,
          yes_bid: bid,
          yes_ask: ask,
          mid_price: parseFloat(mid.toFixed(4)),
          spread: parseFloat((ask - bid).toFixed(4)),
          volume: market.volume_fp,
          open_interest: market.open_interest_fp,
          days_to_close: parseFloat(daysToClose.toFixed(1)),
          close_time: market.close_time,
        };

        const news = newsMap[c.ticker];
        if (news && news.length > 0) enriched.recent_news = news;

        return enriched;
      } catch (err) {
        console.warn(`[Edge] Could not fetch ${c.ticker}: ${err.message}`);
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function run() {
  const state = readState();
  const candidates = state.markets || [];

  if (candidates.length === 0) {
    console.log("[Edge] No candidates from Scout — skipping.");
    return [];
  }

  console.log(`[Edge] Analyzing ${candidates.length} candidates...`);
  writeState({ status: { ...state.status, edge: "running" } });

  try {
    console.log("[Edge] Fetching live market data...");
    const enriched = await enrichWithLiveData(candidates);
    console.log(`[Edge] Enriched ${enriched.length}/${candidates.length} markets`);
    enriched.slice(0, 5).forEach((m) =>
      console.log(
        `  ${m.ticker} | mid=${m.mid_price} spread=${m.spread} days=${m.days_to_close} priority=${m.scout_priority}`
      )
    );

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: `Generate trade signals for these ${enriched.length} Kalshi markets:\n\n${JSON.stringify(enriched, null, 2)}`,
        },
      ],
    });

    const raw = message.content[0]?.text ?? "";
    console.log("[Edge] Claude response:\n", raw);

    let signals = [];
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) signals = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn("[Edge] Could not parse Claude response as JSON");
    }

    const timestamped = signals.map((s) => ({
      ...s,
      generated_at: new Date().toISOString(),
    }));

    writeState({ signals: timestamped, status: { ...state.status, edge: "idle" } });
    console.log(`[Edge] Generated ${timestamped.length} trade signals`);
    timestamped.forEach((s) =>
      console.log(
        `  ${s.ticker} | ${s.side.toUpperCase()} @ ${s.entry_price} | fair=${s.fair_prob} mkt=${s.market_prob} ev=${s.ev} [${s.confidence}]`
      )
    );
    return timestamped;
  } catch (err) {
    writeState({ status: { ...state.status, edge: "error" } });
    console.error("[Edge] Error:", err.message);
    throw err;
  }
}

module.exports = { run };
