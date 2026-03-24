import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import "dotenv/config";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MCP Client (initialized once at startup) ─────────────────────────────────
let mcpClient = null;
let mcpTools = [];

async function initMCP() {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!projectRef) throw new Error("SUPABASE_PROJECT_REF is required");
  if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN is required");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@supabase/mcp-server-supabase", "--project-ref", projectRef, "--read-only"],
    env: {
      ...process.env,
      SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
    },
  });

  mcpClient = new Client({ name: "avail-room", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  // Convert MCP tool schema → Anthropic tool format
  mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  console.log(`✅ MCP connected. Tools: ${mcpTools.map((t) => t.name).join(", ")}`);
}

// ─── Claude + MCP tool loop ───────────────────────────────────────────────────
async function askClaude(userMessage) {
  const today = new Date().toISOString().split("T")[0];

  const messages = [{ role: "user", content: userMessage }];

  const system = `You are a villa availability assistant. Today is ${today}.
Use the Supabase tools to answer availability queries. Follow this flow:
1. Parse the customer's intent: check_in, check_out, bedrooms, location.
2. Query guesty_listings filtered by bedrooms and/or location as needed.
3. If dates given, check guesty_calendar for status = 'available' on each date in the range for the listing_id, OR exclude listing_ids that appear in guesty_reservations with overlapping check_in_date/check_out_date and status IN ('confirmed','inquiry','blocked').
4. Use guesty_calendar.price for nightly price. Fall back to guesty_listings.base_price if calendar price is null.
5. Reply in WhatsApp format: only *bold* and _italic_ — no headers, tables, lists, or code blocks.
6. Include villa name (guesty_listings.title), location, price per night, and total for the stay.
7. IMPORTANT: When calling tools, always pass raw SQL strings — never wrap queries in markdown code blocks or backticks.
8. ONLY query these three tables. Never use listings, addresses, pricing, or any other table name.

Key tables (ONLY these three exist):
- guesty_listings: id, title, location, bedrooms, bathrooms, accommodates, min_nights, base_price, currency
- guesty_calendar: date, listing_id, price, status (available|booked), reservation_id
- guesty_reservations: id, listing_id, status, check_in_date, check_out_date

If no dates given, ask the customer to include a date range.`;

  // Agentic loop: keep going until end_turn (no more tool calls)
  while (true) {
    const response = await claude.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      system,
      tools: mcpTools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      return response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
    }

    if (response.stop_reason === "tool_use") {
      // Append assistant message with tool calls
      messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls against MCP server
      const toolResults = await Promise.all(
        response.content
          .filter((b) => b.type === "tool_use")
          .map(async (toolUse) => {
            console.log(`🔧 MCP call: ${toolUse.name}`, JSON.stringify(toolUse.input));
            try {
              const result = await mcpClient.callTool({
                name: toolUse.name,
                arguments: toolUse.input,
              });
              const content = Array.isArray(result.content)
                ? result.content.map((c) => (typeof c === "object" ? JSON.stringify(c) : c)).join("\n")
                : JSON.stringify(result.content);
              return { type: "tool_result", tool_use_id: toolUse.id, content };
            } catch (err) {
              return {
                type: "tool_result",
                tool_use_id: toolUse.id,
                is_error: true,
                content: err.message,
              };
            }
          })
      );

      messages.push({ role: "user", content: toolResults });
    }
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────────────
// POST /availability  { "message": "Available 2BR villas March 15-20?" }
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
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) =>
  res.json({ status: "ok", mcp: mcpClient ? "connected" : "not ready" })
);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`avail-room API running on port ${PORT}`);
  try {
    await initMCP();
  } catch (err) {
    console.error("❌ MCP init failed:", err.message);
    process.exit(1);
  }
});
