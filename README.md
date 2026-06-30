# Kalshi Agents

An autonomous multi-agent trading system for [Kalshi](https://kalshi.com) prediction markets with a real-time web dashboard. Deploy your own copy in minutes.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/mikeygus25/Kalshified)

---

## What it does

Three AI agents run on a 60-second loop:
- **Scout** — scans Kalshi markets, ranks candidates by trading potential
- **Edge** — calculates expected value and generates trade signals
- **Vault** — executes buys/sells with Kelly criterion sizing and automatic stop-losses

A React dashboard lets you control everything from your phone or laptop.

---

## Deploy your own copy (10 minutes)

### Step 1 — Get your Kalshi API credentials

1. Log in to [kalshi.com](https://kalshi.com)
2. Go to **Account → API** → Create a new API key
3. Download the **RSA private key** `.pem` file
4. Copy your **Key ID** (looks like `433efed1-83b9-...`)

### Step 2 — Encode your private key

You need to convert your `.pem` file to a single-line base64 string. Run this in your terminal:

**Mac/Linux:**
```bash
base64 -i /path/to/your/kalshi_private_key.pem | tr -d '\n'
```

**Windows (PowerShell):**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\kalshi_private_key.pem"))
```

Copy the output — you'll need it in Step 4.

### Step 3 — Click Deploy

Click the **Deploy on Railway** button above. Sign up at [railway.app](https://railway.app) if you don't have an account (free to start).

### Step 4 — Set your environment variables

In Railway → your project → **Variables**, add these:

| Variable | Value | Required |
|----------|-------|----------|
| `KALSHI_API_KEY_ID` | Your Kalshi Key ID | ✅ |
| `KALSHI_PRIVATE_KEY_BASE64` | The base64 string from Step 2 | ✅ |
| `ANTHROPIC_API_KEY` | Your key from [console.anthropic.com](https://console.anthropic.com) | ✅ |
| `KALSHI_ENV` | `demo` (paper) or `prod` (real money) | ✅ |
| `DASHBOARD_USER` | Your dashboard login username | ✅ |
| `DASHBOARD_PASSWORD` | Your dashboard login password | ✅ |
| `JWT_SECRET` | Any long random string | ✅ |
| `MAX_DAILY_LOSS` | Max $ loss before agents stop buying (default: `500`) | ✅ |
| `MAX_POSITION_SIZE` | Max contracts per trade (default: `100`) | ✅ |
| `MAX_OPEN_POSITIONS` | Max simultaneous holdings (default: `10`) | ✅ |
| `SCOUT_INTERVAL` | Pipeline frequency in ms (default: `60000`) | ✅ |
| `VAULT_INTERVAL` | Vault check frequency in ms (default: `10000`) | ✅ |
| `BRAVE_SEARCH_API_KEY` | News context for signals — [get free key](https://api.search.brave.com) | ➖ |
| `TELEGRAM_BOT_TOKEN` | Trade alerts via Telegram | ➖ |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | ➖ |

### Step 5 — Get your URL

Railway → Settings → Networking → **Generate Domain**

Open the URL, log in with your `DASHBOARD_USER` / `DASHBOARD_PASSWORD`, and you're live.

---

## Dashboard

| Page | What you can do |
|------|----------------|
| **Control** | Start/stop agents, trigger manually, watch live logs |
| **Analytics** | P&L chart, win rate, trade history |
| **Config** | Adjust risk limits and intervals without touching code |

---

## Risk controls

- **Stop loss:** sells at 60% loss (disabled during live events < 6 hours to close)
- **Take profit:** sells at 50% of max gain
- **Daily loss limit:** stops buying after hitting `MAX_DAILY_LOSS`
- **Kelly criterion:** quarter-Kelly position sizing (conservative)
- **Claude review:** every buy order is approved by Claude before execution

> ⚠️ Start with `KALSHI_ENV=demo` (paper trading) until you're comfortable with how the agents behave.

---

## Local development

```bash
git clone https://github.com/mikeygus25/Kalshified.git
cd Kalshified
cp .env.template .env
# fill in your .env values
npm install
npm run build
node index.js
```

Open `http://localhost:3000`
