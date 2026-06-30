const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const BASE_PATH = "/trade-api/v2";

function loadPrivateKey() {
  let pem;
  if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
    pem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  } else {
    const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (!keyPath) throw new Error("Set KALSHI_PRIVATE_KEY_BASE64 or KALSHI_PRIVATE_KEY_PATH");
    pem = fs.readFileSync(keyPath, "utf8");
  }
  // createPrivateKey normalises PKCS#1/PKCS#8 and works with OpenSSL 3 on Linux
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

function sign(timestamp, method, path) {
  const message = Buffer.from(`${timestamp}${method}${path}`);
  return crypto.sign("SHA256", message, {
    key:        loadPrivateKey(),
    padding:    crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
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
    const res = await this.http.get("/markets", { params });
    return res.data;
  }

  async getMarket(ticker) {
    const res = await this.http.get(`/markets/${ticker}`);
    return res.data.market;
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
    const res = await this.http.get("/portfolio/positions", { params });
    return res.data;
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
