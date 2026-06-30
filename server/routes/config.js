const express = require("express");
const fs      = require("fs");
const path    = require("path");

const router      = express.Router();
const CONFIG_PATH = path.join(__dirname, "../../config.json");

const ALLOWED_KEYS = [
  "MAX_DAILY_LOSS", "MAX_POSITION_SIZE", "MAX_OPEN_POSITIONS",
  "SCOUT_INTERVAL", "VAULT_INTERVAL", "ROBINHOOD_INTERVAL",
  "KALSHI_ENV",
  "BRAVE_SEARCH_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
  "ROBINHOOD_ACCESS_TOKEN",
];

function readOverrides() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

router.get("/", (req, res) => {
  const overrides = readOverrides();
  const current = {};
  for (const key of ALLOWED_KEYS) {
    current[key] = overrides[key] ?? process.env[key] ?? "";
  }
  res.json(current);
});

router.post("/", (req, res) => {
  const updates   = req.body ?? {};
  const overrides = readOverrides();

  for (const [key, val] of Object.entries(updates)) {
    if (!ALLOWED_KEYS.includes(key)) continue;
    overrides[key]   = val;
    process.env[key] = String(val);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2));
  res.json({ ok: true });
});

module.exports = router;
