const express   = require("express");
const fs        = require("fs");
const path      = require("path");
const tradeLog  = require("../../trade_log");

const router = express.Router();

router.get("/", (req, res) => {
  try {
    const trades = tradeLog.readAll();
    const sells  = trades.filter(t => t.action === "SELL" && t.pnl_dollars !== "");

    const winCount = sells.filter(t => parseFloat(t.pnl_dollars) > 0).length;
    const winRate  = sells.length > 0 ? winCount / sells.length * 100 : 0;

    const totalPnl = trades.length
      ? parseFloat(trades[trades.length - 1].cumulative_pnl_dollars || "0")
      : 0;

    const dailyPnl = tradeLog.getDailyPnl();

    // Build PnL series: one point per trade that has a cumulative value
    const pnlSeries = [];
    for (const t of trades) {
      if (t.cumulative_pnl_dollars !== "") {
        pnlSeries.push({
          date:  t.timestamp,
          value: parseFloat(t.cumulative_pnl_dollars),
        });
      }
    }
    if (pnlSeries.length === 0) {
      pnlSeries.push({ date: new Date().toISOString(), value: 0 });
    }

    let balance = 0;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(__dirname, "../../state.json"), "utf8"));
      balance = (state.portfolio?.balance ?? 0) / 100;
    } catch {}

    res.json({
      balance,
      totalPnl,
      dailyPnl,
      winRate:     parseFloat(winRate.toFixed(1)),
      totalTrades: trades.length,
      sellCount:   sells.length,
      pnlSeries,
      trades:      [...trades].reverse().slice(0, 100),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
