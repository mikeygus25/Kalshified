import { useState, useEffect, useRef } from "react";
import { getAgentStatus, triggerAgent, openLogStream, getSportsStatus, toggleSports, saveSportsLeagues } from "../lib/api";

const AGENTS = [
  { key: "scout",     label: "Scout",     desc: "Market discovery",   icon: "🔭" },
  { key: "edge",      label: "Edge",      desc: "Signal generation",  icon: "⚡" },
  { key: "vault",     label: "Vault",     desc: "Trade execution",    icon: "🔐" },
  { key: "robinhood", label: "Robinhood", desc: "Stock trading",      icon: "🏹" },
];

function StatusDot({ status, isRunning }) {
  if (isRunning) return <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />;
  if (status === "error")   return <span className="inline-block w-2 h-2 rounded-full bg-red-500" />;
  return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />;
}

function AgentCard({ agent, data, running, onTrigger }) {
  const [loading, setLoading] = useState(false);
  const isRunning = agent.key === "robinhood"
    ? running.robinhood
    : running.pipeline || (agent.key === "vault" && running.vault);

  const lastRun = data?.lastUpdated
    ? new Date(data.lastUpdated).toLocaleTimeString()
    : "—";

  const summary =
    agent.key === "scout"     ? (data?.candidateCount != null ? `${data.candidateCount} candidates` : "—") :
    agent.key === "edge"      ? (data?.signalCount      != null ? `${data.signalCount} signals`      : "—") :
    "—";

  async function trigger() {
    setLoading(true);
    try { await onTrigger(agent.key); } finally { setLoading(false); }
  }

  return (
    <div className="bg-card border border-border rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{agent.icon}</span>
          <div>
            <p className="font-semibold text-white leading-tight">{agent.label}</p>
            <p className="text-xs text-gray-500">{agent.desc}</p>
          </div>
        </div>
        <StatusDot status={data?.status} isRunning={isRunning} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <p className="text-gray-500 mb-0.5">Last run</p>
          <p className="text-gray-300 font-mono">{lastRun}</p>
        </div>
        {summary !== "—" && (
          <div>
            <p className="text-gray-500 mb-0.5">Result</p>
            <p className="text-gray-300">{summary}</p>
          </div>
        )}
      </div>

      <button
        onClick={trigger}
        disabled={loading || isRunning}
        className="w-full bg-indigo-600/20 hover:bg-indigo-600/40 disabled:opacity-40 border border-indigo-600/30 text-indigo-300 text-sm font-medium py-2 rounded-lg transition-colors"
      >
        {loading || isRunning ? "Running…" : "▶ Trigger"}
      </button>
    </div>
  );
}

const LOG_COLORS = {
  info:  "text-gray-300",
  error: "text-red-400",
  warn:  "text-yellow-400",
};

// Maps user-facing sport labels to internal ESPN league keys
const SPORT_GROUPS = [
  { label: "NFL",    icon: "🏈", keys: ["nfl"] },
  { label: "NBA",    icon: "🏀", keys: ["nba"] },
  { label: "MLB",    icon: "⚾", keys: ["mlb"] },
  { label: "Soccer", icon: "⚽", keys: ["epl", "mls", "ucl", "laliga"] },
  { label: "Tennis", icon: "🎾", keys: ["atp", "wta", "wimbledon", "usopen_ten"] },
  { label: "Crypto", icon: "₿",  keys: ["crypto"] },
];

function SportsCard({ onToggle }) {
  const [sports, setSports]         = useState(null);
  const [toggling, setToggling]     = useState(false);
  const [savingLeagues, setSaving]  = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try { const s = await getSportsStatus(); if (!cancelled) setSports(s); } catch {}
    }
    poll();
    const id = setInterval(poll, 8000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  async function handleToggle() {
    setToggling(true);
    try {
      const result = await toggleSports();
      setSports(prev => ({ ...prev, enabled: result.enabled }));
      if (onToggle) onToggle();
    } finally {
      setToggling(false);
    }
  }

  async function handleLeagueToggle(group) {
    if (!sports) return;
    const current = sports.leagues ?? [];
    const allOn   = group.keys.every(k => current.includes(k));
    const next    = allOn
      ? current.filter(k => !group.keys.includes(k))   // turn group off
      : [...new Set([...current, ...group.keys])];       // turn group on
    setSports(prev => ({ ...prev, leagues: next }));
    setSaving(true);
    try { await saveSportsLeagues(next); } finally { setSaving(false); }
  }

  const enabled  = sports?.enabled ?? false;
  const leagues  = sports?.leagues ?? [];
  const lastRun  = sports?.lastRun ? new Date(sports.lastRun).toLocaleTimeString() : "—";

  return (
    <div className={`col-span-1 sm:col-span-2 xl:col-span-4 bg-card border rounded-xl p-5 space-y-4 ${enabled ? "border-emerald-600/40" : "border-border"}`}>
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl">🏆</span>
          <div>
            <p className="font-semibold text-white">Live Sports Trading</p>
            <p className="text-xs text-gray-500">
              Scans ESPN every 60s for mispriced Kalshi odds
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {sports && enabled && (
            <div className="text-right text-xs text-gray-500">
              <p>{sports.lastGames ?? 0} live game(s)</p>
              <p>Last scan: {lastRun}</p>
            </div>
          )}
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={`px-6 py-2.5 rounded-lg font-semibold text-sm transition-all whitespace-nowrap ${
              enabled
                ? "bg-emerald-600 hover:bg-emerald-500 text-white"
                : "bg-gray-700 hover:bg-gray-600 text-gray-300"
            }`}
          >
            {toggling ? "…" : enabled ? "🟢 Scanning ON" : "⚫ Scanning OFF"}
          </button>
        </div>
      </div>

      {/* Sport pickers */}
      <div>
        <p className="text-xs text-gray-500 mb-2">
          Sports to scan {savingLeagues && <span className="text-indigo-400">saving…</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          {SPORT_GROUPS.map(group => {
            const active = group.keys.some(k => leagues.includes(k));
            return (
              <button
                key={group.label}
                onClick={() => handleLeagueToggle(group)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all ${
                  active
                    ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
                    : "bg-transparent border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-400"
                }`}
              >
                <span>{group.icon}</span>
                {group.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Control() {
  const [status, setStatus]   = useState(null);
  const [logs, setLogs]       = useState([]);
  const [pinned, setPinned]   = useState(true);
  const [pipeResult, setPipeResult] = useState(null);
  const logRef = useRef(null);

  // Poll agent status every 5s
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await getAgentStatus();
        if (!cancelled) setStatus(s);
      } catch {}
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Live log stream
  useEffect(() => {
    const es = openLogStream((entry) => {
      setLogs((prev) => [...prev.slice(-499), entry]);
    });
    return () => es.close();
  }, []);

  // Auto-scroll when pinned
  useEffect(() => {
    if (pinned && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, pinned]);

  async function handleTrigger(name) {
    setPipeResult(null);
    const result = await triggerAgent(name);
    if (result.ok) setPipeResult({ ok: true, ...result });
    else setPipeResult({ ok: false, error: result.error });
    const s = await getAgentStatus();
    setStatus(s);
  }

  async function runAll() {
    setPipeResult(null);
    const result = await triggerAgent("all");
    setPipeResult(result);
    const s = await getAgentStatus();
    setStatus(s);
  }

  const running = status?.running ?? {};
  const agents  = status?.agents  ?? {};
  const portfolio = status?.portfolio;

  return (
    <div className="p-4 lg:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Control Panel</h2>
          {portfolio && (
            <p className="text-sm text-gray-500 mt-0.5">
              Balance: <span className="text-white font-medium">${portfolio.balance.toFixed(2)}</span>
              &nbsp;·&nbsp;
              {portfolio.openPositions} open position{portfolio.openPositions !== 1 ? "s" : ""}
            </p>
          )}
        </div>
        <button
          onClick={runAll}
          disabled={running.pipeline}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-lg transition-colors text-sm"
        >
          <span>{running.pipeline ? "⏳" : "🚀"}</span>
          {running.pipeline ? "Pipeline running…" : "Run Full Pipeline"}
        </button>
      </div>

      {/* Result banner */}
      {pipeResult && (
        <div className={`rounded-lg px-4 py-3 text-sm ${pipeResult.ok ? "bg-emerald-900/30 border border-emerald-700/40 text-emerald-300" : "bg-red-900/30 border border-red-700/40 text-red-300"}`}>
          {pipeResult.ok
            ? `✓ Done — ${pipeResult.candidates ?? "?"}c candidates · ${pipeResult.signals ?? "?"}c signals · ${pipeResult.bought ?? 0} bought · ${pipeResult.sold ?? 0} sold`
            : `✗ ${pipeResult.error}`}
        </div>
      )}

      {/* Agent cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {AGENTS.map((agent) => (
          <AgentCard
            key={agent.key}
            agent={agent}
            data={agents[agent.key]}
            running={running}
            onTrigger={handleTrigger}
          />
        ))}
        <SportsCard onToggle={() => getAgentStatus().then(setStatus)} />
      </div>

      {/* Live Logs */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-white">Live Logs</span>
            <span className="text-xs text-gray-500">{logs.length} entries</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLogs([])}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              Clear
            </button>
            <button
              onClick={() => setPinned((p) => !p)}
              className={`text-xs transition-colors ${pinned ? "text-indigo-400" : "text-gray-500 hover:text-white"}`}
            >
              {pinned ? "📌 Pinned" : "📌 Pin"}
            </button>
          </div>
        </div>
        <div
          ref={logRef}
          className="h-80 overflow-y-auto font-mono text-xs p-4 space-y-0.5 bg-[#0a0d14]"
        >
          {logs.length === 0 ? (
            <p className="text-gray-600">Waiting for log output…</p>
          ) : (
            logs.map((entry, i) => (
              <p key={i} className={LOG_COLORS[entry.level] ?? "text-gray-300"}>
                <span className="text-gray-600 select-none">
                  {new Date(entry.ts).toLocaleTimeString()}&nbsp;
                </span>
                {entry.message}
              </p>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
