const axios = require("axios");

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const LEAGUES = [
  { key: "nfl",        label: "NFL",              path: "football/nfl" },
  { key: "nba",        label: "NBA",              path: "basketball/nba" },
  { key: "mlb",        label: "MLB",              path: "baseball/mlb" },
  { key: "epl",        label: "Soccer (EPL)",     path: "soccer/eng.1" },
  { key: "mls",        label: "Soccer (MLS)",     path: "soccer/usa.1" },
  { key: "ucl",        label: "Soccer (UCL)",     path: "soccer/uefa.champions" },
  { key: "laliga",     label: "Soccer (La Liga)", path: "soccer/esp.1" },
  { key: "atp",        label: "Tennis (ATP)",     path: "tennis/atp" },
  { key: "wta",        label: "Tennis (WTA)",     path: "tennis/wta" },
  { key: "wimbledon",  label: "Wimbledon",        path: "tennis/wimbledon" },
  { key: "usopen_ten", label: "US Open Tennis",   path: "tennis/us-open" },
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
      const events = data.events ?? [];
      if (events.length === 0) {
        console.log(`[ESPN] ${league.label}: no events today`);
      } else {
        const statuses = [...new Set(events.map(e => e.status?.type?.name ?? "unknown"))];
        console.log(`[ESPN] ${league.label}: ${events.length} event(s) — statuses: ${statuses.join(", ")}`);
      }
      for (const ev of events) {
        const statusName = ev.status?.type?.name ?? "";
        if (!LIVE_STATUSES.has(statusName)) continue;

        const comp  = ev.competitions?.[0];
        if (!comp) continue;

        const isTennis = ["atp", "wta"].includes(league.key);
        const competitors = comp.competitors ?? [];

        // Tennis uses athletes (players), not teams with homeAway
        let home, away;
        if (isTennis) {
          home = competitors[0];
          away = competitors[1];
        } else {
          home = competitors.find(c => c.homeAway === "home");
          away = competitors.find(c => c.homeAway === "away");
        }
        if (!home || !away) continue;

        // Tennis: name comes from athlete, not team
        const homeName  = isTennis
          ? (home.athlete?.displayName ?? home.athlete?.shortName ?? home.id ?? "Player 1")
          : (home.team?.displayName ?? "");
        const homeAbbr  = isTennis
          ? (home.athlete?.shortName ?? homeName.split(" ").pop())
          : (home.team?.abbreviation ?? "");
        const awayName  = isTennis
          ? (away.athlete?.displayName ?? away.athlete?.shortName ?? away.id ?? "Player 2")
          : (away.team?.displayName ?? "");
        const awayAbbr  = isTennis
          ? (away.athlete?.shortName ?? awayName.split(" ").pop())
          : (away.team?.abbreviation ?? "");

        const homeScore = isTennis ? (home.sets?.length ?? parseInt(home.score ?? "0", 10)) : parseInt(home.score ?? "0", 10);
        const awayScore = isTennis ? (away.sets?.length ?? parseInt(away.score ?? "0", 10)) : parseInt(away.score ?? "0", 10);

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
          home: { name: homeName, abbr: homeAbbr, score: homeScore },
          away: { name: awayName, abbr: awayAbbr, score: awayScore },
          summary: `${awayAbbr} ${awayScore} vs ${homeAbbr} ${homeScore} · ${periodLabel(league.key, period)}`,
        });
      }
    } catch {
      // league not live or ESPN unavailable — skip silently
    }
  }

  return games;
}

module.exports = { getLiveGames, LEAGUES };
