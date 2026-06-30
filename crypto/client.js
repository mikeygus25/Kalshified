const axios = require("axios");

const COINS = [
  { id: "bitcoin",     symbol: "BTC",  name: "Bitcoin" },
  { id: "ethereum",    symbol: "ETH",  name: "Ethereum" },
  { id: "solana",      symbol: "SOL",  name: "Solana" },
  { id: "ripple",      symbol: "XRP",  name: "XRP" },
  { id: "dogecoin",    symbol: "DOGE", name: "Dogecoin" },
  { id: "binancecoin", symbol: "BNB",  name: "BNB" },
  { id: "cardano",     symbol: "ADA",  name: "Cardano" },
];

async function getPrices() {
  const ids = COINS.map(c => c.id).join(",");
  const { data } = await axios.get(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_1hr_change=true`,
    { timeout: 8000 }
  );
  return COINS.map(c => ({
    symbol:    c.symbol,
    name:      c.name,
    price:     data[c.id]?.usd          ?? null,
    change1h:  data[c.id]?.usd_1h_change  ?? null,
    change24h: data[c.id]?.usd_24h_change ?? null,
  })).filter(c => c.price !== null);
}

module.exports = { getPrices, COINS };
