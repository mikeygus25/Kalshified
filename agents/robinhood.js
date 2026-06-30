/**
 * Robinhood Agent — reviews portfolio, evaluates opportunities, and executes stock trades
 * via the Robinhood MCP server using Claude's native MCP connector.
 *
 * Requires: ROBINHOOD_ACCESS_TOKEN in .env
 * Obtain token via: npx @modelcontextprotocol/inspector → connect to the MCP URL → OAuth flow
 */
const Anthropic = require("@anthropic-ai/sdk");
const telegram  = require("../telegram");

const anthropic = new Anthropic();

const MCP_SERVER_URL = "https://agent.robinhood.com/mcp/trading";
const MODEL          = "claude-opus-4-7";

// US Eastern time market hours: 9:30 AM – 4:00 PM
function isMarketHours() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

const SYSTEM_PROMPT = `You are a disciplined stock trading agent with access to a Robinhood brokerage account.

Your workflow on each run:
1. Fetch current portfolio, cash balance, and positions
2. Check prices and recent performance of watchlisted tickers
3. Apply your edge criteria: momentum continuations, mean-reversion setups, or event-driven catalysts
4. Execute approved orders; explain any you pass on

Hard risk limits — never violate:
- Maximum 2% of total portfolio value per new position
- Maximum 15% of portfolio in any single holding at market value
- Equities and ETFs only — no options, crypto, or leveraged products
- Limit orders only, never market orders; use current bid/ask midpoint
- Do not trade within 15 minutes of market open (9:30–9:45 ET) or close (3:45–4:00 ET)
- If you cannot verify current price or account state, do nothing

After completing your review return ONLY a JSON object with this exact shape:
{
  "portfolio_value_usd": number,
  "cash_available_usd": number,
  "positions_reviewed": number,
  "actions_taken": [
    {
      "symbol": string,
      "action": "buy" | "sell",
      "quantity": number,
      "limit_price_usd": number,
      "rationale": string
    }
  ],
  "opportunities_passed": [
    { "symbol": string, "reason": string }
  ],
  "summary": string
}

Return empty arrays for actions_taken and opportunities_passed if you do nothing.
Be conservative — if in doubt, sit on your hands.`;

// Extract final text from a response content array
function extractText(content) {
  return content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

// Parse the JSON result block from Claude's response text
function parseResult(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function run() {
  const token = process.env.ROBINHOOD_ACCESS_TOKEN;
  if (!token) {
    console.log("[Robinhood] Skipping — ROBINHOOD_ACCESS_TOKEN not set");
    return { actions_taken: [], summary: "Token not configured" };
  }

  if (!isMarketHours()) {
    console.log("[Robinhood] Skipping — outside market hours");
    return { actions_taken: [], summary: "Outside market hours" };
  }

  console.log("[Robinhood] Starting trading run...");

  const messages = [
    {
      role: "user",
      content:
        `Review my Robinhood portfolio. Check watchlist prices, manage existing positions, ` +
        `and execute any high-conviction trades within the risk rules. ` +
        `Today is ${new Date().toISOString().split("T")[0]}, ` +
        `current time ET: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}.`,
    },
  ];

  let finalText = null;

  // Agentic loop: Anthropic executes MCP tool calls server-side; we only need to
  // handle pause_turn (server hit iteration limit) by re-sending the partial response.
  while (true) {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages,
      mcp_servers: [
        {
          type: "url",
          url: MCP_SERVER_URL,
          name: "robinhood",
          authorization_token: token,
        },
      ],
      tools: [{ type: "mcp_toolset", mcp_server_name: "robinhood" }],
      betas: ["mcp-client-2025-11-20"],
    });

    if (response.stop_reason === "end_turn") {
      finalText = extractText(response.content);
      break;
    }

    if (response.stop_reason === "pause_turn") {
      // MCP tool iteration limit hit — append and continue
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    console.warn(`[Robinhood] Unexpected stop_reason: ${response.stop_reason}`);
    finalText = extractText(response.content);
    break;
  }

  const result = finalText ? parseResult(finalText) : null;
  const actions = result?.actions_taken ?? [];

  console.log(`[Robinhood] Run complete — actions: ${actions.length}, summary: ${result?.summary ?? "(none)"}`);

  for (const action of actions) {
    const total = (action.quantity * action.limit_price_usd).toFixed(2);
    console.log(
      `  [Robinhood] ${action.action.toUpperCase()} ${action.quantity}x ${action.symbol}` +
      ` @ $${action.limit_price_usd} (total ~$${total}) — ${action.rationale}`
    );
    telegram.send(
      `${action.action === "buy" ? "📈 BUY" : "📉 SELL"} | ${action.symbol}\n` +
      `${action.quantity}x @ $${action.limit_price_usd} (~$${total})\n` +
      action.rationale
    ).catch(() => {});
  }

  return result ?? { actions_taken: [], summary: finalText ?? "No response" };
}

module.exports = { run };
