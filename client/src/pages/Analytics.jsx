import { useState, useEffect } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { getAnalytics } from "../lib/api";

function StatCard({ label, value, sub, color }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? "text-white"}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function pnlColor(v) {
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-red-400";
  return "text-gray-300";
}

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const val = payload[0]?.value ?? 0;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-gray-400 mb-1">{new Date(label).toLocaleString()}</p>
      <p className={`font-semibold ${val >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        {val >= 0 ? "+" : ""}${val.toFixed(2)}
      </p>
    </div>
  );
}

export default function Analytics() {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAnalytics()
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Loading analytics…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-500">Failed to load data.</p>
      </div>
    );
  }

  const lineColor = data.totalPnl >= 0 ? "#10b981" : "#ef4444";

  return (
    <div className="p-4 lg:p-8 space-y-6 max-w-5xl mx-auto">
      <h2 className="text-xl font-bold text-white">Analytics</h2>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Balance"
          value={`$${data.balance.toFixed(2)}`}
        />
        <StatCard
          label="Total P&L"
          value={`${data.totalPnl >= 0 ? "+" : ""}$${data.totalPnl.toFixed(2)}`}
          color={pnlColor(data.totalPnl)}
        />
        <StatCard
          label="Today's P&L"
          value={`${data.dailyPnl >= 0 ? "+" : ""}$${data.dailyPnl.toFixed(2)}`}
          color={pnlColor(data.dailyPnl)}
          sub="realized"
        />
        <StatCard
          label="Win Rate"
          value={`${data.winRate}%`}
          sub={`${data.sellCount} closed trades`}
        />
      </div>

      {/* P&L Chart */}
      <div className="bg-card border border-border rounded-xl p-5">
        <p className="text-sm font-medium text-white mb-4">Cumulative P&L</p>
        {data.pnlSeries.length <= 1 ? (
          <div className="h-52 flex items-center justify-center text-gray-500 text-sm">
            No trade history yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.pnlSeries} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e2635" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#6b7280", fontSize: 10 }}
                tickFormatter={(v) =>
                  new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                }
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: "#6b7280", fontSize: 10 }}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={0} stroke="#374151" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="value"
                stroke={lineColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: lineColor }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Trade Table */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <p className="text-sm font-medium text-white">Trade History</p>
          <p className="text-xs text-gray-500">{data.totalTrades} total</p>
        </div>
        <div className="overflow-x-auto">
          {data.trades.length === 0 ? (
            <p className="text-center text-gray-500 text-sm py-12">No trades yet</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Date", "Action", "Ticker", "Side", "Qty", "Price", "P&L", "Trigger"].map((h) => (
                    <th key={h} className="text-left text-xs text-gray-500 font-medium px-4 py-3 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t, i) => {
                  const pnl    = t.pnl_dollars !== "" ? parseFloat(t.pnl_dollars) : null;
                  const isBuy  = t.action === "BUY";
                  return (
                    <tr key={i} className="border-b border-border/50 hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                        {t.date} {t.time}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
                          isBuy
                            ? "bg-blue-900/40 text-blue-400"
                            : "bg-purple-900/40 text-purple-400"
                        }`}>
                          {t.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-300 whitespace-nowrap">{t.ticker}</td>
                      <td className="px-4 py-3 text-xs text-gray-400">{t.side}</td>
                      <td className="px-4 py-3 text-xs text-gray-300 text-right">{t.contracts}</td>
                      <td className="px-4 py-3 text-xs text-gray-300 text-right whitespace-nowrap">
                        {t.price_cents}¢
                      </td>
                      <td className={`px-4 py-3 text-xs text-right font-medium ${
                        pnl === null ? "text-gray-600" :
                        pnl >= 0    ? "text-emerald-400" : "text-red-400"
                      }`}>
                        {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{t.trigger || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
