import express from "express";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import "dotenv/config";

// ─── Constants ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// LLM
const MODEL = "x-ai/grok-4.1-fast";
const MAX_TOKENS = 1024;
const MAX_TOOL_ITERATIONS = 10; // safety cap to prevent infinite loops

// Query limits (kept in one place so prompt + any future code stay in sync)
const LIMIT = {
  LISTINGS: 5,
  CALENDAR: 30, // LISTINGS * max_nights (5 × 6)
  RESERVATIONS: 5,
  RESULTS: 3,   // max results shown to customer
};

// DB tables
const TABLE = {
  LISTINGS:     "guesty_listings",
  CALENDAR:     "guesty_calendar",
  RESERVATIONS: "guesty_reservations",
};

// Columns to SELECT per table (never SELECT *)
const COLUMNS = {
  LISTINGS:     "id, title, location, bedrooms, base_price, currency, min_nights",
  CALENDAR:     "listing_id, date, price, status",
  RESERVATIONS: "listing_id",
};

// Reservation statuses that block availability
const BLOCKING_STATUSES = ["confirmed", "inquiry", "blocked"];

// MCP client identity
const MCP_CLIENT_INFO = { name: "avail-room", version: "1.0.0" };

// ─── Clients ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": `https://${process.env.AVAIL_ROOM_DOMAIN || "avail.localhost"}`,
    "X-Title": "Avail Room",
  },
});

// ─── MCP State ────────────────────────────────────────────────────────────────
let mcpClient = null;
let mcpTools = [];

async function initMCP() {
  const { SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN } = process.env;
  if (!SUPABASE_PROJECT_REF) throw new Error("SUPABASE_PROJECT_REF is required");
  if (!SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN is required");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@supabase/mcp-server-supabase", "--project-ref", SUPABASE_PROJECT_REF, "--read-only"],
    env: { ...process.env, SUPABASE_ACCESS_TOKEN },
  });

  mcpClient = new Client(MCP_CLIENT_INFO, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  mcpTools = tools.map(({ name, description, inputSchema }) => ({
    type: "function",
    function: { name, description, parameters: inputSchema },
  }));

  console.log(`✅ MCP connected — tools: ${mcpTools.map((t) => t.function.name).join(", ")}`);
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];

  return `You are a villa availability assistant. Today is ${today}.

## Hard Query Rules
- NEVER SELECT * — only SELECT the columns listed below per table.
- ALWAYS enforce these LIMITs: ${TABLE.LISTINGS} → LIMIT ${LIMIT.LISTINGS}, ${TABLE.CALENDAR} → LIMIT ${LIMIT.CALENDAR}, ${TABLE.RESERVATIONS} → LIMIT ${LIMIT.RESERVATIONS}.
- Filter with WHERE in SQL — never pull all rows and filter in memory.
- NEVER wrap SQL in markdown, code blocks, or backticks.
- ONLY query these three tables — no others exist:
  • ${TABLE.LISTINGS}(${COLUMNS.LISTINGS})
  • ${TABLE.CALENDAR}(${COLUMNS.CALENDAR})
  • ${TABLE.RESERVATIONS}(listing_id, id, status, check_in_date, check_out_date)

## Availability Flow
1. Parse intent: check_in, check_out, bedrooms, location.
   → If dates are missing, ask the customer for them and STOP — do not query anything.

2. Fetch matching listings (one query):
   SELECT ${COLUMNS.LISTINGS}
   FROM ${TABLE.LISTINGS}
   WHERE bedrooms = {n} AND location ILIKE '%{loc}%'
   LIMIT ${LIMIT.LISTINGS}

3. Check availability in two batched queries using ALL listing IDs at once:
   a) Calendar — all nights must be 'available':
      SELECT ${COLUMNS.CALENDAR}
      FROM ${TABLE.CALENDAR}
      WHERE listing_id = ANY('{id1,id2,...}'::uuid[])
        AND date BETWEEN '{check_in}' AND '{check_out}'::date - 1
        AND status = 'available'
      LIMIT ${LIMIT.CALENDAR}

   b) Blocking reservations:
      SELECT ${COLUMNS.RESERVATIONS}
      FROM ${TABLE.RESERVATIONS}
      WHERE listing_id = ANY('{id1,id2,...}'::uuid[])
        AND status IN (${BLOCKING_STATUSES.map((s) => `'${s}'`).join(", ")})
        AND check_in_date < '{check_out}' AND check_out_date > '{check_in}'
      LIMIT ${LIMIT.RESERVATIONS}

4. A listing is available only if:
   - ALL nights in range appear in ${TABLE.CALENDAR} with status = 'available', AND
   - No row returned in the reservations query for that listing_id.

5. Present at most ${LIMIT.RESULTS} available results — do not fetch more listings once ${LIMIT.RESULTS} are found.
   Use ${TABLE.CALENDAR}.price for nightly rate; fall back to ${TABLE.LISTINGS}.base_price if null.
   If fewer than ${LIMIT.RESULTS} found, say so — never fabricate availability.

## Reply Format (WhatsApp only)
Use only *bold* and _italic_. No headers, tables, bullet lists, or code blocks.
Include: villa name, location, price/night, total for stay.`;
}

// ─── Tool Executor ────────────────────────────────────────────────────────────
async function executeTool({ id, function: { name, arguments: rawArgs } }) {
  const args = JSON.parse(rawArgs);
  console.log(`🔧 [${name}]`, JSON.stringify(args));

  try {
    const result = await mcpClient.callTool({ name, arguments: args });
    const content = Array.isArray(result.content)
      ? result.content.map((c) => (typeof c === "object" ? JSON.stringify(c) : c)).join("\n")
      : JSON.stringify(result.content);
    return { role: "tool", tool_call_id: id, content };
  } catch (err) {
    console.error(`❌ Tool error [${name}]:`, err.message);
    return { role: "tool", tool_call_id: id, content: `Error: ${err.message}` };
  }
}

// ─── Agentic Loop ─────────────────────────────────────────────────────────────
async function askClaude(userMessage) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const { choices } = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: mcpTools,
      messages,
    });

    const { finish_reason, message } = choices[0];

    if (finish_reason === "stop") {
      return message.content?.trim() ?? "";
    }

    if (finish_reason === "tool_calls") {
      messages.push(message);
      const toolResults = await Promise.all(message.tool_calls.map(executeTool));
      messages.push(...toolResults);
      continue;
    }

    // Unexpected finish reason
    console.warn(`⚠️ Unexpected finish_reason: ${finish_reason}`);
    break;
  }

  throw new Error("Exceeded max tool iterations — possible loop detected");
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/availability", async (req, res) => {
  const { message } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  if (!mcpClient) {
    return res.status(503).json({ error: "MCP not ready yet" });
  }

  try {
    const reply = await askClaude(message);
    res.json({ reply });
  } catch (err) {
    console.error("❌ /availability error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", mcp: mcpClient ? "connected" : "not ready" })
);

// ─── Startup ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 avail-room running on port ${PORT}`);
  try {
    await initMCP();
  } catch (err) {
    console.error("❌ MCP init failed:", err.message);
    process.exit(1);
  }
});