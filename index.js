require("dotenv").config();

// Install log interceptor before anything else so we capture all agent output
const logger = require("./server/logger");
logger.install();

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const scout     = require("./agents/scout");
const edge      = require("./agents/edge");
const vault     = require("./agents/vault");
const robinhood = require("./agents/robinhood");
const sports    = require("./agents/sports");
const kalshi    = require("./kalshi/client");
const tradeLog  = require("./trade_log");

const { authMiddleware, loginHandler } = require("./server/auth");
const agentsRoute  = require("./server/routes/agents");
const analyticsRoute = require("./server/routes/analytics");
const configRoute  = require("./server/routes/config");

// Apply config.json overrides on top of .env
const CONFIG_PATH = path.join(__dirname, "config.json");
try {
  const overrides = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  for (const [k, v] of Object.entries(overrides)) process.env[k] = String(v);
} catch {}

const STATE_PATH         = path.join(__dirname, "state.json");
const PORT               = parseInt(process.env.PORT              || "3000",   10);
const SCOUT_INTERVAL     = parseInt(process.env.SCOUT_INTERVAL    || "300000", 10); // 5 min default
const VAULT_INTERVAL     = parseInt(process.env.VAULT_INTERVAL    || "10000",  10);
const ROBINHOOD_INTERVAL = parseInt(process.env.ROBINHOOD_INTERVAL || "300000", 10);

const app = express();
app.use(express.json());

const running = { pipeline: false, vault: false, robinhood: false, sports: false };

// Sports state — toggled via API, persists in memory (resets on restart)
const sportsState = {
  enabled: false,
  leagues: ["nfl", "nba", "mlb", "epl", "mls", "ucl", "laliga", "atp", "wta", "wimbledon", "usopen_ten"],
  intervalId: null,
  lastRun: null,
  lastGames: 0,
  lastSignals: 0,
};

async function runSports() {
  if (running.sports) return;
  running.sports = true;
  try {
    const result = await sports.run(sportsState.leagues);
    sportsState.lastRun     = new Date().toISOString();
    sportsState.lastGames   = result.games;
    sportsState.lastSignals = result.signals.length;
    // After sports signals are merged, run Vault to act on them
    if (result.signals.length > 0 && !running.pipeline) {
      await vault.run();
    }
  } catch (err) {
    console.error("[Main] Sports error:", err.message);
  } finally {
    running.sports = false;
  }
}

function startSportsLoop() {
  if (sportsState.intervalId) return;
  console.log("[Main] Sports scanning started");
  runSports().catch(console.error);
  sportsState.intervalId = setInterval(() => runSports().catch(console.error), 60000);
}

function stopSportsLoop() {
  if (sportsState.intervalId) {
    clearInterval(sportsState.intervalId);
    sportsState.intervalId = null;
    console.log("[Main] Sports scanning stopped");
  }
}

const DEFAULT_STATE = { markets: [], signals: [], positions: [], portfolio: {}, positionAssessments: [], lastUpdated: {}, status: {} };

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return { ...DEFAULT_STATE }; }
}

async function runPipeline() {
  if (running.pipeline) {
    console.log("[Main] Pipeline already running — skipping");
    return null;
  }
  running.pipeline = true;
  const start = Date.now();
  console.log("\n[Main] ─── Pipeline starting ───────────────────────────");
  try {
    const candidates = await scout.run();
    console.log(`[Main] Scout → ${candidates.length} candidates`);

    if (candidates.length === 0) {
      console.log("[Main] No candidates — skipping Edge + Vault");
      return { candidates: 0, signals: 0, orders: 0 };
    }

    const signals = await edge.run();
    console.log(`[Main] Edge → ${signals.length} signals`);

    let vaultResult = { sold: [], placed: [] };
    if (signals.length > 0 || true) {
      vaultResult = await vault.run();
      console.log(`[Main] Vault → sold=${vaultResult.sold.length} bought=${vaultResult.placed.length}`);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[Main] ─── Pipeline done in ${elapsed}s ────────────────────\n`);
    return { candidates: candidates.length, signals: signals.length, sold: vaultResult.sold.length, bought: vaultResult.placed.length };
  } catch (err) {
    console.error("[Main] Pipeline error:", err.message);
    throw err;
  } finally {
    running.pipeline = false;
  }
}

async function runRobinhood() {
  if (running.robinhood) {
    console.log("[Main] Robinhood already running — skipping");
    return;
  }
  running.robinhood = true;
  try {
    await robinhood.run();
  } catch (err) {
    console.error("[Main] Robinhood error:", err.message);
  } finally {
    running.robinhood = false;
  }
}

async function runVaultOnly() {
  if (running.vault || running.pipeline) return;
  running.vault = true;
  try {
    await vault.run();
  } catch (err) {
    console.error("[Main] Vault-only error:", err.message);
  } finally {
    running.vault = false;
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.post("/api/auth/login", loginHandler);

// ─── Protected API routes ────────────────────────────────────────────────────

app.use("/api/logs/stream", authMiddleware, logger.streamHandler);

agentsRoute.init({ running, runPipeline, scout, edge, vault, robinhood });
app.use("/api/agents", authMiddleware, agentsRoute.router);
app.use("/api/analytics", authMiddleware, analyticsRoute);
app.use("/api/config", authMiddleware, configRoute);

// ─── Sports toggle endpoints ─────────────────────────────────────────────────

app.get("/api/sports/status", authMiddleware, (req, res) => {
  res.json({
    enabled:     sportsState.enabled,
    leagues:     sportsState.leagues,
    running:     running.sports,
    lastRun:     sportsState.lastRun,
    lastGames:   sportsState.lastGames,
    lastSignals: sportsState.lastSignals,
  });
});

app.post("/api/sports/toggle", authMiddleware, (req, res) => {
  sportsState.enabled = !sportsState.enabled;
  if (sportsState.enabled) startSportsLoop();
  else stopSportsLoop();
  console.log(`[Main] Sports scanning ${sportsState.enabled ? "ENABLED" : "DISABLED"}`);
  res.json({ enabled: sportsState.enabled });
});

app.post("/api/sports/leagues", authMiddleware, (req, res) => {
  const { leagues } = req.body;
  if (Array.isArray(leagues)) sportsState.leagues = leagues;
  res.json({ leagues: sportsState.leagues });
});

// ─── Open positions endpoint ─────────────────────────────────────────────────

app.get("/api/positions", authMiddleware, async (req, res) => {
  try {
    const [posData, balData] = await Promise.all([
      kalshi.getPositions(),
      kalshi.getBalance(),
    ]);
    const balance   = balData.balance ?? balData.available_balance ?? 0;
    const positions = (posData.market_positions ?? []).filter(
      p => parseFloat(p.position_fp ?? "0") !== 0
    );

    // Enrich each position with market title and current price
    const enriched = await Promise.allSettled(
      positions.map(async p => {
        const ticker = p.ticker ?? p.market_ticker;
        try {
          const market = await kalshi.getMarket(ticker);
          const side   = parseFloat(p.position_fp) > 0 ? "yes" : "no";
          const qty    = Math.abs(parseFloat(p.position_fp));
          const midCents = side === "yes"
            ? ((market.yes_bid ?? 0) + (market.yes_ask ?? 0)) / 2
            : ((market.no_bid  ?? 0) + (market.no_ask  ?? 0)) / 2;
          return {
            ticker,
            title:        market.title ?? ticker,
            side,
            qty,
            mid_cents:    Math.round(midCents),
            close_time:   market.close_time ?? market.expiration_time ?? null,
            status:       market.status ?? "open",
          };
        } catch {
          return { ticker, title: ticker, side: "yes", qty: Math.abs(parseFloat(p.position_fp ?? 1)), mid_cents: null };
        }
      })
    );

    res.json({
      balance_cents: balance,
      positions: enriched.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Legacy HTTP endpoints (kept for backward compat) ────────────────────────

app.get("/trades", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(tradeLog.toHTML());
});

app.get("/trades.csv", (_req, res) => {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="trade_log.csv"');
  res.send(fs.existsSync(tradeLog.LOG_PATH) ? fs.readFileSync(tradeLog.LOG_PATH, "utf8") : "No trades yet\n");
});

app.get("/status", (_req, res) => {
  const state = readState();
  res.json({ ...state, running });
});

app.post("/run/scout",     async (req, res) => { try { const r = await scout.run(); res.json({ ok: true, candidates: r.length }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });
app.post("/run/edge",      async (req, res) => { try { const r = await edge.run();  res.json({ ok: true, signals: r.length });    } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });
app.post("/run/vault",     async (req, res) => { try { const r = await vault.run(); res.json({ ok: true, sold: r.sold.length, bought: r.placed.length }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });
app.post("/run/all",       async (req, res) => { try { const r = await runPipeline(); if (r === null) return res.json({ ok: false, error: "Pipeline already running" }); res.json({ ok: true, ...r }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });
app.post("/run/robinhood", async (req, res) => { try { const r = await robinhood.run(); res.json({ ok: true, summary: r.summary }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); } });

// ─── Serve React dashboard ───────────────────────────────────────────────────

const CLIENT_DIST = path.join(__dirname, "client", "dist");
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/run/")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Main] kalshi-agents starting (env: ${process.env.KALSHI_ENV || "demo"})`);

  try {
    const bal     = await kalshi.ping();
    const balance = bal.balance ?? bal.available_balance ?? 0;
    console.log(`[Main] Kalshi credentials verified — balance: $${(balance / 100).toFixed(2)}`);

    // Sanity-check price normalization with one real market
    const sample = await kalshi.getMarkets({ limit: 1, status: "open" });
    const m = sample.markets?.[0];
    if (m) {
      console.log(`[Main] Price check: ${m.ticker} yes_bid=${m.yes_bid} → yes_bid_dollars=${m.yes_bid_dollars} yes_ask_dollars=${m.yes_ask_dollars}`);
    }
  } catch (err) {
    // Don't crash the server on auth failure — log and continue so the dashboard stays up
    console.error("[Main] Kalshi auth warning:", err.message);
  }

  app.listen(PORT, () =>
    console.log(`[Main] HTTP server → http://localhost:${PORT}`)
  );

  await runPipeline().catch(console.error);

  setInterval(() => runPipeline().catch(console.error), SCOUT_INTERVAL);
  setInterval(() => runVaultOnly(), VAULT_INTERVAL);

  if (process.env.ROBINHOOD_ACCESS_TOKEN) {
    setInterval(() => runRobinhood().catch(console.error), ROBINHOOD_INTERVAL);
    console.log(`[Main] Robinhood loop started — every ${ROBINHOOD_INTERVAL / 1000}s (market hours only)`);
  } else {
    console.log("[Main] Robinhood disabled — set ROBINHOOD_ACCESS_TOKEN to enable");
  }

  console.log(
    `[Main] Loops started — pipeline every ${SCOUT_INTERVAL / 1000}s, vault check every ${VAULT_INTERVAL / 1000}s`
  );
}

main();
