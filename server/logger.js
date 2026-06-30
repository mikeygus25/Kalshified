const clients  = new Set();
const buffer   = [];
const MAX_BUF  = 500;

function broadcast(level, message) {
  const entry = { level, message, ts: Date.now() };
  buffer.push(entry);
  if (buffer.length > MAX_BUF) buffer.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { clients.delete(res); }
  }
}

function fmt(args) {
  return args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
}

function install() {
  const origLog   = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  console.log   = (...args) => { origLog(...args);   broadcast("info",  fmt(args)); };
  console.error = (...args) => { origError(...args); broadcast("error", fmt(args)); };
  console.warn  = (...args) => { origWarn(...args);  broadcast("warn",  fmt(args)); };
}

function streamHandler(req, res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  // Replay buffer for the new client
  for (const entry of buffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  clients.add(res);
  req.on("close", () => clients.delete(res));
}

module.exports = { install, streamHandler };
