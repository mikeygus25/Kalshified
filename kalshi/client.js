const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const BASE_PATH = "/trade-api/v2";

function loadPrivateKey() {
  let pem;
  if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
    console.log("[Kalshi] Loading key from KALSHI_PRIVATE_KEY_BASE64, length:", process.env.KALSHI_PRIVATE_KEY_BASE64.length);
    pem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  } else {
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    console.log("[Kalshi] Loading key from path:", keyPath);
    if (!keyPath) throw new Error("Set KALSHI_PRIVATE_KEY_BASE64 or KALSHI_PRIVATE_KEY_PATH");
    pem = fs.readFileSync(keyPath, "utf8");
  }
  console.log("[Kalshi] PEM first line:", pem.split("\n")[0]);
  try {
    return crypto.createPrivateKey({ key: pem, format: "pem" });
  } catch (err) {
    console.error("[Kalshi] createPrivateKey failed:", err.message);
    console.error("[Kalshi] PEM length:", pem.length, "| starts with:", JSON.stringify(pem.slice(0, 40)));
    throw err;
  }
}

function sign(timestamp, method, path) {
  const message = Buffer.from(`${timestamp}${method}${path}`);
  return crypto.sign("SHA256", message, {
    key:        loadPrivateKey(),
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
}

// Kalshi v2 returns prices as integer cents (0–99).
// Agents expect _dollars (0.00–1.00) and _fp float fields.
// Normalize once here so agents never need to know the wire format.
function normalizeMarket(m) {
  if (!m) return m;
  if (m.yes_bid_dollars == null) m.yes_bid_dollars = (m.yes_bid ?? 0) / 100;
  if (m.yes_ask_dollars == null) m.yes_ask_dollars = (m.yes_ask ?? 0) / 100;
  if (m.no_bid_dollars  == null) m.no_bid_dollars  = (m.no_bid  ?? 0) / 100;
  if (m.no_ask_dollars  == null) m.no_ask_dollars  = (m.no_ask  ?? 0) / 100;
  if (m.volume_fp        == null) m.volume_fp        = m.volume        ?? 0;
  if (m.open_interest_fp == null) m.open_interest_fp = m.open_interest ?? 0;
  return m;
}

function normalizePosition(p) {
  if (!p) return p;
  // API uses "market_ticker" not "ticker", and integer "position" not "position_fp"
  if (p.ticker == null && p.market_ticker) p.ticker = p.market_ticker;
  if (p.position_fp     == null) p.position_fp     = p.position ?? 0;
  if (p.total_traded_dollars == null) p.total_traded_dollars = (p.total_cost ?? 0) / 100;
  return p;
}

class KalshiClient {
  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      headers: { "Content-Type": "application/json" },
    });

    this.http.interceptors.request.use((config) => {
      const timestamp = Date.now().toString();
      const method = config.method.toUpperCase();
      // config.url is the relative path, e.g. "/markets"
      const path = BASE_PATH + config.url.split("?")[0];

      config.headers["KALSHI-ACCESS-KEY"] = process.env.KALSHI_API_KEY_ID;
      config.headers["KALSHI-ACCESS-TIMESTAMP"] = timestamp;
      config.headers["KALSHI-ACCESS-SIGNATURE"] = sign(timestamp, method, path);
      return config;
    });
  }

  // Events
  async getEvents(params = {}) {
    const res = await this.http.get("/events", { params });
    return res.data;
  }

  async getEventMarkets(eventTicker, params = {}) {
    const res = await this.http.get("/markets", { params: { ...params, event_ticker: eventTicker } });
    return res.data;
  }

  // Markets
  async getMarkets(params = {}) {
    const res  = await this.http.get("/markets", { params });
    const data = res.data;
    if (Array.isArray(data.markets)) data.markets = data.markets.map(normalizeMarket);
    return data;
  }

  async getMarket(ticker) {
    const res = await this.http.get(`/markets/${ticker}`);
    return normalizeMarket(res.data.market);
  }

  async getMarketOrderbook(ticker) {
    const res = await this.http.get(`/markets/${ticker}/orderbook`);
    return res.data;
  }

  // Portfolio
  async getBalance() {
    const res = await this.http.get("/portfolio/balance");
    return res.data;
  }

  async getPositions(params = {}) {
    const res  = await this.http.get("/portfolio/positions", { params });
    const data = res.data;
    if (Array.isArray(data.market_positions)) data.market_positions = data.market_positions.map(normalizePosition);
    return data;
  }

  async getFills(params = {}) {
    const res = await this.http.get("/portfolio/fills", { params });
    return res.data;
  }

  // Orders
  async createOrder(order) {
    const res = await this.http.post("/portfolio/orders", order);
    return res.data;
  }

  async cancelOrder(orderId) {
    const res = await this.http.delete(`/portfolio/orders/${orderId}`);
    return res.data;
  }

  async getOrders(params = {}) {
    const res = await this.http.get("/portfolio/orders", { params });
    return res.data;
  }

  // Verify credentials by fetching balance
  async ping() {
    return this.getBalance();
  }
}

module.exports = new KalshiClient();
