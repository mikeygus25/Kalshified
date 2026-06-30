const express = require("express");
const fs      = require("fs");
const path    = require("path");

const router = express.Router();

// Injected by init() from index.js
let _running, _runPipeline, _scout, _edge, _vault, _robinhood;

function init({ running, runPipeline, scout, edge, vault, robinhood }) {
  _running     = running;
  _runPipeline = runPipeline;
  _scout       = scout;
  _edge        = edge;
  _vault       = vault;
  _robinhood   = robinhood;
}

function readState() {
  const STATE_PATH = path.join(__dirname, "../../state.json");
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

router.get("/status", (req, res) => {
  const state = readState();
  const balanceCents = state.portfolio?.balance ?? 0;
  res.json({
    running: _running,
    agents: {
      scout: {
        status:         state.status?.scout ?? "idle",
        lastUpdated:    state.lastUpdated?.scout ?? null,
        candidateCount: Array.isArray(state.markets) ? state.markets.length : 0,
      },
      edge: {
        status:      state.status?.edge ?? "idle",
        lastUpdated: state.lastUpdated?.edge ?? null,
        signalCount: Array.isArray(state.signals) ? state.signals.length : 0,
      },
      vault: {
        status:      state.status?.vault ?? "idle",
        lastUpdated: state.lastUpdated?.vault ?? null,
      },
      robinhood: {
        status:      _running.robinhood ? "running" : "idle",
        lastUpdated: null,
      },
    },
    portfolio: {
      balance:       balanceCents / 100,
      openPositions: state.portfolio?.openPositions ?? 0,
    },
  });
});

router.post("/trigger/scout", async (req, res) => {
  try {
    if (_running.pipeline) return res.json({ ok: false, error: "Pipeline already running" });
    const result = await _scout.run();
    res.json({ ok: true, candidates: result.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/trigger/edge", async (req, res) => {
  try {
    if (_running.pipeline) return res.json({ ok: false, error: "Pipeline already running" });
    const result = await _edge.run();
    res.json({ ok: true, signals: result.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/trigger/vault", async (req, res) => {
  try {
    const result = await _vault.run();
    res.json({ ok: true, sold: result.sold.length, bought: result.placed.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/trigger/all", async (req, res) => {
  try {
    const result = await _runPipeline();
    if (result === null) return res.json({ ok: false, error: "Pipeline already running" });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/trigger/robinhood", async (req, res) => {
  try {
    const result = await _robinhood.run();
    res.json({ ok: true, summary: result.summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router, init };
