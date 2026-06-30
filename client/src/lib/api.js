function token() {
  return localStorage.getItem("token");
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token()}`,
  };
}

function handleUnauth(res) {
  if (res.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "/login";
  }
}

export async function login(username, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("Invalid credentials");
  return res.json();
}

export async function getAgentStatus() {
  const res = await fetch("/api/agents/status", { headers: authHeaders() });
  handleUnauth(res);
  return res.json();
}

export async function triggerAgent(name) {
  const res = await fetch(`/api/agents/trigger/${name}`, {
    method: "POST",
    headers: authHeaders(),
  });
  handleUnauth(res);
  return res.json();
}

export async function getAnalytics() {
  const res = await fetch("/api/analytics", { headers: authHeaders() });
  handleUnauth(res);
  return res.json();
}

export async function getConfig() {
  const res = await fetch("/api/config", { headers: authHeaders() });
  handleUnauth(res);
  return res.json();
}

export async function saveConfig(config) {
  const res = await fetch("/api/config", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(config),
  });
  handleUnauth(res);
  return res.json();
}

// Returns an EventSource — caller must call .close() on unmount
export function openLogStream(onMessage) {
  const es = new EventSource(`/api/logs/stream?token=${token()}`);
  es.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  };
  return es;
}

export async function getSportsStatus() {
  const res = await fetch("/api/sports/status", { headers: authHeaders() });
  handleUnauth(res);
  return res.json();
}

export async function toggleSports() {
  const res = await fetch("/api/sports/toggle", { method: "POST", headers: authHeaders() });
  handleUnauth(res);
  return res.json();
}

export async function saveSportsLeagues(leagues) {
  const res = await fetch("/api/sports/leagues", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ leagues }),
  });
  handleUnauth(res);
  return res.json();
}
