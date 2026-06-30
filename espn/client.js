const axios = require("axios");

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const LEAGUES = [
  { key: "nfl",        label: "NFL",              path: "football/nfl",          sport: "football" },
  { key: "nba",        label: "NBA",              path: "basketball/nba",         sport: "basketball" },
  { key: "mlb",        label: "MLB",              path: "baseball/mlb",           sport: "baseball" },
  { key: "epl",        label: "Soccer (EPL)",     path: "soccer/eng.1",           sport: "soccer" },
  { key: "mls",        label: "Soccer (MLS)",     path: "soccer/usa.1",           sport: "soccer" },
  { key: "ucl",        label: "Soccer (UCL)",     path: "soccer/uefa.champions",  sport: "soccer" },
  { key: "laliga",     label: "Soccer (La Liga)", path: "soccer/esp.1",           sport: "soccer" },
  { key: "atp",        label: "Tennis (ATP)",     path: "tennis/atp",             sport: "tennis" },
  { key: "wta",        label: "Tennis (WTA)",     path: "tennis/wta",             sport: "tennis" },
  { key: "wimbledon",  label: "Wimbledon",        path: "tennis/wimbledon",       sport: "tennis" },
  { key: "usopen_ten", label: "US Open Tennis",   path: "tennis/us-open",         sport: "tennis" },
];

const isTennis = key => ["atp", "wta", "wimbledon", "usopen_ten"].includes(key);

// Returns today's scoreboard for a league: all games (scheduled, live, final) plus team records
async function getContext(leagueKey) {
  const league = LEAGUES.find(l => l.key === leagueKey);
  if (!league) return null;

  try {
    const { data } = await axios.get(`${ESPN_BASE}/${league.path}/scoreboard`, { timeout: 8000 });
    const events   = data.events ?? [];

    const games = events.map(ev => {
      const comp        = ev.competitions?.[0];
      const competitors = comp?.competitors ?? [];
      const tennis      = isTennis(leagueKey);

      const p1 = competitors[0];
      const p2 = competitors[1];
      const homeC = competitors.find(c => c.homeAway === "home") ?? p1;
      const awayC = competitors.find(c => c.homeAway === "away") ?? p2;

      function teamInfo(c, fallbackIndex) {
        const raw = competitors[fallbackIndex];
        if (tennis) {
          const athlete = c?.athlete ?? raw?.athlete;
          return {
            name:   athlete?.displayName ?? athlete?.fullName ?? `Player ${fallbackIndex + 1}`,
            record: c?.record?.[0]?.summary ?? null,
            score:  c?.score ?? raw?.score ?? null,
          };
        }
        return {
          name:   c?.team?.displayName ?? `Team ${fallbackIndex + 1}`,
          abbr:   c?.team?.abbreviation,
          record: c?.records?.[0]?.summary ?? c?.record?.[0]?.summary ?? null,
          score:  c?.score ?? null,
        };
      }

      const home = teamInfo(homeC, 0);
      const away = teamInfo(awayC, 1);

      return {
        name:      ev.name,
        status:    ev.status?.type?.description ?? ev.status?.type?.name ?? "Unknown",
        startTime: ev.date,
        clock:     ev.status?.displayClock ?? null,
        period:    ev.status?.period ?? null,
        home,
        away,
      };
    });

    console.log(`[ESPN] ${league.label}: ${games.length} game(s) — ${[...new Set(games.map(g => g.status))].join(", ")}`);
    return { league: league.label, sport: league.sport, games };
  } catch (err) {
    console.log(`[ESPN] ${league.label}: unavailable (${err.message})`);
    return null;
  }
}

// Fetch context for all enabled league keys concurrently
async function getContextForLeagues(enabledKeys) {
  const sportKeys = enabledKeys.filter(k => k !== "crypto");
  const results   = await Promise.all(sportKeys.map(k => getContext(k)));
  const context   = {};
  sportKeys.forEach((k, i) => { if (results[i]) context[k] = results[i]; });
  return context;
}

module.exports = { getContextForLeagues, LEAGUES };
