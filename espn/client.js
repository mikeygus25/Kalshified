const axios = require("axios");

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const LEAGUES = [
  { key: "nfl",    label: "NFL",              path: "football/nfl" },
  { key: "nba",    label: "NBA",              path: "basketball/nba" },
  { key: "mlb",    label: "MLB",              path: "baseball/mlb" },
  { key: "epl",    label: "Soccer (EPL)",     path: "soccer/eng.1" },
  { key: "mls",    label: "Soccer (MLS)",     path: "soccer/usa.1" },
  { key: "ucl",    label: "Soccer (UCL)",     path: "soccer/uefa.champions" },
  { key: "laliga", label: "Soccer (La Liga)", path: "soccer/esp.1" },
  { key: "atp",    label: "Tennis (ATP)",     path: "tennis/atp" },
  { key: "wta",    label: "Tennis (WTA)",     path: "tennis/wta" },
];

const LIVE_STATUSES = new Set([
  "STATUS_IN_PROGRESS",
  "STATUS_HALFTIME",
  "STATUS_END_PERIOD",
]);

function periodLabel(key, period) {
  if (key === "nfl" || key === "nba") return ["Q1","Q2","Q3","Q4","OT"][period - 1] ?? `P${period}`;
  if (key === "mlb") return `Inning ${period}`;
  if (["epl","mls","ucl","laliga"].includes(key)) return period === 1 ? "1st Half" : "2nd Half";
  return `Set ${period}`;
}

async function getLiveGames(enabledKeys) {
  const active = LEAGUES.filter(l => enabledKeys.includes(l.key));
  const games  = [];

  for (const league of active) {
    try {
      const { data } = await axios.get(`${ESPN_BASE}/${league.path}/scoreboard`, { timeout: 6000 });
      for (const ev of data.events ?? []) {
        const statusName = ev.status?.type?.name ?? "";
        if (!LIVE_STATUSES.has(statusName)) continue;

        const comp  = ev.competitions?.[0];
        if (!comp) continue;

        const home = comp.competitors?.find(c => c.homeAway === "home");
        const away = comp.competitors?.find(c => c.homeAway === "away");
        if (!home || !away) continue;

        const clock  = ev.status?.displayClock ?? "";
        const period = ev.status?.period ?? 1;

        games.push({
          league:    league.key,
          leagueLabel: league.label,
          gameId:    ev.id,
          name:      ev.name,
          shortName: ev.shortName,
          status:    statusName,
          clock,
          period,
          periodLabel: periodLabel(league.key, period),
          home: {
            name:  home.team?.displayName ?? "",
            abbr:  home.team?.abbreviation ?? "",
            score: parseInt(home.score ?? "0", 10),
          },
          away: {
            name:  away.team?.displayName ?? "",
            abbr:  away.team?.abbreviation ?? "",
            score: parseInt(away.score ?? "0", 10),
          },
          summary: `${away.team?.abbreviation} ${away.score ?? 0} @ ${home.team?.abbreviation} ${home.score ?? 0} · ${clock} ${periodLabel(league.key, period)}`,
        });
      }
    } catch {
      // league not live or ESPN unavailable — skip silently
    }
  }

  return games;
}

module.exports = { getLiveGames, LEAGUES };
