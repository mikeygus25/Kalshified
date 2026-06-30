/**
 * Telegram trade alerts.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable.
 *
 * Setup (2 minutes):
 *   1. Message @BotFather on Telegram → /newbot → follow prompts → copy the token
 *   2. Start your bot (search its username, click Start)
 *   3. Visit https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates to find your chat_id
 *   4. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env
 */
const axios = require("axios");

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function send(text) {
  if (!isConfigured()) return;
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }
  ).catch(err => console.warn("[Telegram] Send failed:", err.message));
}

async function alertBuy({ ticker, title, side, count, price_cents }) {
  const total = (price_cents * count / 100).toFixed(2);
  return send(
    `BUY ${side.toUpperCase()} | ${ticker}\n` +
    `${title ? title + "\n" : ""}` +
    `${count}x @ ${price_cents}c = $${total}`
  );
}

async function alertSell({ ticker, side, count, price_cents, pnl, trigger }) {
  const sign = pnl >= 0 ? "+" : "";
  return send(
    `SELL ${side.toUpperCase()} | ${ticker}\n` +
    `${count}x @ ${price_cents}c\n` +
    `PnL: ${sign}$${pnl.toFixed(2)} | ${trigger}`
  );
}

async function alertError(context, message) {
  return send(`ERROR in ${context}:\n${message}`);
}

module.exports = { send, alertBuy, alertSell, alertError, isConfigured };
