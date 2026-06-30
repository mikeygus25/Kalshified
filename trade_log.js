/**
 * Trade log — appends one CSV row per trade immediately after execution.
 * Also syncs to Google Sheets asynchronously (fire-and-forget).
 */
const fs     = require("fs");
const path   = require("path");
const sheets = require("./sheets");

const LOG_PATH = path.join(__dirname, "trade_log.csv");

const HEADERS = [
  "timestamp", "date", "time",
  "action",    "ticker", "title", "side", "contracts",
  "price_cents", "price_dollars", "total_dollars",
  "avg_entry_dollars", "pnl_dollars", "cumulative_pnl_dollars",
  "trigger", "order_id",
];

function init() {
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, HEADERS.join(",") + "\n");
  }
}

function escape(v) {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function getCumulativePnl() {
  if (!fs.existsSync(LOG_PATH)) return 0;
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
  if (lines.length <= 1) return 0;
  const last = lines[lines.length - 1].split(",");
  const idx  = HEADERS.indexOf("cumulative_pnl_dollars");
  return parseFloat(last[idx] ?? "0") || 0;
}

function append(row) {
  init();
  const line = HEADERS.map(h => escape(row[h])).join(",");
  fs.appendFileSync(LOG_PATH, line + "\n");
}

// ─── public API ──────────────────────────────────────────────────────────────

function logBuy({ ticker, title, side, count, price_cents, order_id }) {
  init();
  const now          = new Date();
  const priceDollars = price_cents / 100;
  const totalDollars = (priceDollars * count).toFixed(4);
  const cumPnl       = getCumulativePnl();

  append({
    timestamp:              now.toISOString(),
    date:                   now.toLocaleDateString("en-US"),
    time:                   now.toLocaleTimeString("en-US"),
    action:                 "BUY",
    ticker,
    title,
    side:                   side.toUpperCase(),
    contracts:              count,
    price_cents,
    price_dollars:          priceDollars.toFixed(4),
    total_dollars:          totalDollars,
    avg_entry_dollars:      "",
    pnl_dollars:            "",
    cumulative_pnl_dollars: cumPnl.toFixed(4),
    trigger:                "",
    order_id:               order_id ?? "",
  });

  // Sync to Google Sheets asynchronously — never blocks Vault
  sheets.appendRow([
    now.toISOString(), now.toLocaleDateString("en-US"), now.toLocaleTimeString("en-US"),
    "BUY", ticker, title, side.toUpperCase(), count,
    price_cents, priceDollars.toFixed(4), totalDollars,
    "", "", cumPnl.toFixed(4), "", order_id ?? "",
  ]).catch(err => console.warn("[TradeLog] Sheets sync failed:", err.message));

  console.log(`[TradeLog] BUY  ${count}x ${ticker} @ ${price_cents}¢ ($${totalDollars}) — logged`);
}

function logSell({ ticker, title, side, count, price_cents, avg_entry_dollars, trigger, order_id }) {
  init();
  const now          = new Date();
  const exitDollars  = price_cents / 100;
  const avgEntry     = avg_entry_dollars ?? 0;
  const pnl          = (exitDollars - avgEntry) * count;
  const cumPnl       = getCumulativePnl() + pnl;

  append({
    timestamp:              now.toISOString(),
    date:                   now.toLocaleDateString("en-US"),
    time:                   now.toLocaleTimeString("en-US"),
    action:                 "SELL",
    ticker,
    title,
    side:                   side.toUpperCase(),
    contracts:              count,
    price_cents,
    price_dollars:          exitDollars.toFixed(4),
    total_dollars:          (exitDollars * count).toFixed(4),
    avg_entry_dollars:      avgEntry.toFixed(4),
    pnl_dollars:            pnl.toFixed(4),
    cumulative_pnl_dollars: cumPnl.toFixed(4),
    trigger:                trigger ?? "",
    order_id:               order_id ?? "",
  });

  // Sync to Google Sheets asynchronously — never blocks Vault
  sheets.appendRow([
    now.toISOString(), now.toLocaleDateString("en-US"), now.toLocaleTimeString("en-US"),
    "SELL", ticker, title, side.toUpperCase(), count,
    price_cents, exitDollars.toFixed(4), (exitDollars * count).toFixed(4),
    avgEntry.toFixed(4), pnl.toFixed(4), cumPnl.toFixed(4),
    trigger ?? "", order_id ?? "",
  ]).catch(err => console.warn("[TradeLog] Sheets sync failed:", err.message));

  const sign = pnl >= 0 ? "+" : "";
  console.log(
    `[TradeLog] SELL ${count}x ${ticker} @ ${price_cents}¢ | PnL: ${sign}$${pnl.toFixed(4)} | Cumulative: $${cumPnl.toFixed(4)} — logged`
  );
}

// ─── HTML report for the /trades endpoint ────────────────────────────────────

function readAll() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n");
  if (lines.length <= 1) return [];
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = "", inQuote = false;
    for (const ch of line + ",") {
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { vals.push(cur); cur = ""; continue; }
      cur += ch;
    }
    return Object.fromEntries(HEADERS.map((h, i) => [h, vals[i] ?? ""]));
  });
}

function toHTML() {
  const rows = readAll();
  const totalPnl = rows.length
    ? parseFloat(rows[rows.length - 1].cumulative_pnl_dollars || "0")
    : 0;
  const sign  = totalPnl >= 0 ? "+" : "";
  const color = totalPnl >= 0 ? "#16a34a" : "#dc2626";

  const rowsHTML = rows.map(r => {
    const isBuy  = r.action === "BUY";
    const hasPnl = r.pnl_dollars !== "";
    const pnlNum = hasPnl ? parseFloat(r.pnl_dollars) : 0;
    const pnlColor = pnlNum >= 0 ? "#16a34a" : "#dc2626";
    return `<tr>
      <td>${r.date} ${r.time}</td>
      <td><span style="font-weight:600;color:${isBuy ? "#2563eb" : "#7c3aed"}">${r.action}</span></td>
      <td style="font-family:monospace;font-size:12px">${r.ticker}</td>
      <td>${r.title}</td>
      <td>${r.side}</td>
      <td style="text-align:right">${r.contracts}</td>
      <td style="text-align:right">${r.price_cents}¢</td>
      <td style="text-align:right">$${r.total_dollars}</td>
      <td style="text-align:right">${r.avg_entry_dollars ? "$" + r.avg_entry_dollars : "—"}</td>
      <td style="text-align:right;color:${hasPnl ? pnlColor : "inherit"}">${hasPnl ? (pnlNum >= 0 ? "+" : "") + "$" + r.pnl_dollars : "—"}</td>
      <td style="text-align:right">${r.cumulative_pnl_dollars ? "$" + r.cumulative_pnl_dollars : "—"}</td>
      <td style="font-size:11px;color:#6b7280">${r.trigger || "—"}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="refresh" content="10">
<title>Trade Log</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f9fafb;color:#111}
  h1{margin:0 0 4px;font-size:22px}
  .sub{color:#6b7280;margin:0 0 20px;font-size:14px}
  .stat{display:inline-block;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;margin:0 12px 20px 0}
  .stat-label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  .stat-value{font-size:24px;font-weight:700;color:${color}}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th{background:#f3f4f6;padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
  td{padding:10px 12px;border-top:1px solid #f3f4f6;font-size:13px;white-space:nowrap}
  tr:hover td{background:#f9fafb}
</style></head><body>
<h1>Trade Log</h1>
<p class="sub">Auto-refreshes every 10 s · ${rows.length} trade${rows.length === 1 ? "" : "s"}</p>
<div class="stat"><div class="stat-label">Realized PnL</div><div class="stat-value">${sign}$${totalPnl.toFixed(2)}</div></div>
<table>
<thead><tr>
  <th>Time</th><th>Action</th><th>Ticker</th><th>Title</th><th>Side</th>
  <th>Contracts</th><th>Price</th><th>Total</th><th>Avg Entry</th>
  <th>PnL</th><th>Cumulative</th><th>Trigger</th>
</tr></thead>
<tbody>${rowsHTML || '<tr><td colspan="12" style="text-align:center;padding:40px;color:#6b7280">No trades yet</td></tr>'}</tbody>
</table></body></html>`;
}

// Returns the set of tickers where the bot placed a BUY (i.e. bot-managed positions)
function getBotBuyTickers() {
  const rows = readAll();
  return new Set(rows.filter(r => r.action === "BUY").map(r => r.ticker));
}

// Sum of realized PnL from SELL rows logged today
function getDailyPnl() {
  const today = new Date().toLocaleDateString("en-US");
  return readAll()
    .filter(r => r.date === today && r.action === "SELL" && r.pnl_dollars !== "")
    .reduce((sum, r) => sum + (parseFloat(r.pnl_dollars) || 0), 0);
}

// Compute weighted-average entry price for the bot's current open position in a ticker.
// Uses FIFO accounting across all logged BUY/SELL rows for that ticker.
function getPositionAvgEntry(ticker) {
  const rows = readAll().filter(r => r.ticker === ticker);
  let contracts = 0;
  let totalCost  = 0;
  for (const row of rows) {
    const count = parseFloat(row.contracts || 0);
    const price = parseFloat(row.price_dollars || 0);
    if (row.action === "BUY") {
      totalCost += count * price;
      contracts += count;
    } else if (row.action === "SELL" && contracts > 0) {
      const pct = Math.min(count / contracts, 1);
      totalCost  *= (1 - pct);
      contracts  -= count;
    }
  }
  return contracts > 0 ? totalCost / contracts : 0;
}

module.exports = { logBuy, logSell, toHTML, readAll, getBotBuyTickers, getDailyPnl, getPositionAvgEntry, LOG_PATH };
