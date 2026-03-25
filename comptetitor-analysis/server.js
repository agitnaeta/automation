import express from "express";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { v4 as uuidv4 } from "uuid";
import "dotenv/config";

const app = express();
app.use(express.json());

const processedMessageIds = new Set();

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  port: process.env.PORT || 3000,
  wahaBaseUrl: process.env.WAHA_BASE_URL || "http://localhost:3000",
  wahaApiKey: process.env.WAHA_API_KEY || "",
  wahaSession: process.env.WAHA_SESSION || "default",
};

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": `https://${process.env.REPLY_DOMAIN || "reply.naetalab.com"}`,
    "X-Title": "Competitor Analysis Bot",
  },
});

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

  mcpClient = new Client({ name: "competitor-analysis", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();
  // Convert MCP tool schema → OpenAI tool format
  mcpTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  console.log(`✅ MCP connected. Tools: ${mcpTools.map((t) => t.function.name).join(", ")}`);
}

// ─── OpenRouter + MCP agentic loop ────────────────────────────────────────────
async function askOpenRouter(systemPrompt, userMessage) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await openai.chat.completions.create({
      model: "anthropic/claude-opus-4.6",
      max_tokens: 1024,
      tools: mcpTools.length > 0 ? mcpTools : undefined,
      messages,
    });

    const choice = response.choices[0];

    if (choice.finish_reason === "stop") {
      return choice.message.content?.trim() ?? "";
    }

    if (choice.finish_reason === "tool_calls") {
      messages.push(choice.message);

      const toolResults = await Promise.all(
        choice.message.tool_calls.map(async (toolCall) => {
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`🔧 MCP call: ${toolCall.function.name}`, JSON.stringify(args));
          try {
            const result = await mcpClient.callTool({
              name: toolCall.function.name,
              arguments: args,
            });
            const content = Array.isArray(result.content)
              ? result.content.map((c) => (typeof c === "object" ? JSON.stringify(c) : c)).join("\n")
              : JSON.stringify(result.content);
            return { role: "tool", tool_call_id: toolCall.id, content };
          } catch (err) {
            return { role: "tool", tool_call_id: toolCall.id, content: `Error: ${err.message}` };
          }
        })
      );

      messages.push(...toolResults);
    }
  }
}

async function isVillaContext(text) {
  const low = (text || "").toLowerCase();
  const explicit = ["villa", "villa booking", "villa availability", "villas", "villa rental", "villa price", "villa stay"].some((k) => low.includes(k));
  if (explicit) return true;

  try {
    const result = await askOpenRouter(
      "You are a strict context classifier. Reply with ONLY one word: yes or no.",
      `Is this WhatsApp message from a customer about a villa listing, villa booking, villa availability, or villa property details?\nMessage: "${text.replace(/"/g, '\\"')}"`
    );
    const normalized = (result || "").trim().toLowerCase();
    if (/^yes/.test(normalized)) return true;
    if (/^no/.test(normalized)) return false;
    return false;
  } catch (err) {
    console.warn("Villa context classifier failed, defaulting to false:", err.message);
    return false;
  }
}

// ─── WAHA Send Text ───────────────────────────────────────────────────────────
async function sendWhatsAppReply({ chatId, replyTo, text, session }) {
  const url = `${CONFIG.wahaBaseUrl}/api/sendText`;

  const body = {
    session: session || CONFIG.wahaSession,
    chatId,
    text,
    reply_to: replyTo || null,
    linkPreview: false,
    linkPreviewHighQuality: false,
  };

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (CONFIG.wahaApiKey) {
    headers["X-Api-Key"] = CONFIG.wahaApiKey;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WAHA API error ${res.status}: ${errText}`);
  }

  return res.json();
}

// ─── Parse WAHA Webhook Payload ───────────────────────────────────────────────
function parseWebhookMessage(body) {
  const event = body?.event;
  const payload = body?.payload;

  if (!payload) return null;

  if (event === "session.status") {
    const chatId = body?.me?.id || payload?.me?.id || "unknown";
    return {
      event,
      type: "session_status",
      status: payload?.status || payload?.statuses?.slice(-1)?.[0]?.status || "unknown",
      session: body?.session || payload?.name || CONFIG.wahaSession,
      chatId,
      metadata: payload,
    };
  }

  const fromMe = [
    payload?.fromMe,
    payload?.key?.fromMe,
    payload?.message?.fromMe,
    payload?.message?.key?.fromMe,
    payload?.sender?.fromMe,
    body?.me?.id === payload?.from,
    body?.me?.id === payload?.key?.remoteJid,
    body?.me?.id === payload?.chatId,
  ].some((v) => v === true || v === body?.me?.id);

  if (fromMe) {
    console.log("Ignored outgoing message (fromMe=true or own id)");
    return null;
  }

  const text =
    payload?.body ||
    payload?.message?.conversation ||
    payload?.message?.extendedTextMessage?.text ||
    payload?.message?.conversation;

  if (!text || typeof text !== "string") return null;

  const chatId =
    payload?.key?.remoteJid ||
    payload?.from ||
    payload?.chatId;

  const allowedSuffixes = ["8161", "0334", "6780"];
  const normalizedId = (chatId || "").toString();
  const senderNumber = normalizedId.replace(/[^0-9]/g, "");
  const isAllowed = true; // For testing, allow all numbers.
  if (!isAllowed) {
    return { event, type: "ignored_number", chatId, senderNumber, text };
  }

  const messageId =
    payload?.key?.id ||
    payload?.id;

  const senderName =
    payload?.pushName ||
    payload?.notifyName ||
    "Someone";

  const session = body?.session || CONFIG.wahaSession;

  return { event, type: "message", chatId, messageId, text, senderName, session };
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const requestId = uuidv4().slice(0, 8);
  const body = req.body;

  console.log(`\n[${requestId}] 📨 Webhook received:`, JSON.stringify(body, null, 2));

  res.json({ status: "received", requestId });

  const msg = parseWebhookMessage(body);

  if (!msg) {
    console.log(`[${requestId}] ⏭  Skipped (no actionable text or outgoing message)`);
    return;
  }

  if (msg.messageId) {
    const dedupeKey = `${msg.chatId}::${msg.messageId}`;
    if (processedMessageIds.has(dedupeKey)) {
      console.log(`[${requestId}] ⏭  Skipped duplicate message ID ${dedupeKey}`);
      return;
    }
    processedMessageIds.add(dedupeKey);
    if (processedMessageIds.size > 1000) {
      const firstKey = processedMessageIds.values().next().value;
      processedMessageIds.delete(firstKey);
    }
  }

  if (msg.type === "session_status") {
    console.log(`[${requestId}] 🔁 Session status event (${msg.session}) from ${msg.chatId}: ${msg.status}`);
    return;
  }

  if (msg.type === "ignored_number") {
    console.log(`[${requestId}] ⏭  Ignored number ${msg.senderNumber} from chatId ${msg.chatId}.`);
    return;
  }

  console.log(`[${requestId}] 💬 From: ${msg.senderName} (${msg.chatId})`);
  console.log(`[${requestId}] 📝 Text: "${msg.text}"`);

  const villa = await isVillaContext(msg.text);
  if (!villa) {
    console.log(`[${requestId}] ⏭ Skipped - not villa context`);
    return;
  }

  try {
    console.log(`[${requestId}] 🤖 Sending to OpenRouter...`);
    const today = new Date().toISOString().split("T")[0];
    const systemPrompt = `You are a villa availability assistant. Today is ${today}.
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

    const reply = await askOpenRouter(systemPrompt, msg.text);
    console.log(`[${requestId}] ✅ Replied: "${reply.slice(0, 120)}..."`);

    const replyTo = msg.messageId ? `${msg.chatId}_${msg.messageId}` : null;

    await sendWhatsAppReply({ chatId: msg.chatId, replyTo, text: reply, session: msg.session });
    console.log(`[${requestId}] 📤 Reply sent to ${msg.chatId}`);
  } catch (err) {
    console.error(`[${requestId}] ❌ Error:`, err.message);
    try {
      await sendWhatsAppReply({
        chatId: msg.chatId,
        replyTo: null,
        text: "⚠️ Sorry, I couldn't process your request right now. Please try again.",
        session: msg.session,
      });
    } catch (sendErr) {
      console.error(`[${requestId}] ❌ Failed to send error message:`, sendErr.message);
    }
  }
});

// ─── Manual send endpoint ──────────────────────────────────────────────────────
app.post("/send", async (req, res) => {
  const { chatId, text, replyTo, session } = req.body;
  if (!chatId || !text) {
    return res.status(400).json({ error: "chatId and text are required" });
  }
  try {
    const result = await sendWhatsAppReply({ chatId, text, replyTo, session });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual ask + send ─────────────────────────────────────────────────────────
app.post("/ask-and-send", async (req, res) => {
  const { chatId, prompt, session } = req.body;
  if (!chatId || !prompt) {
    return res.status(400).json({ error: "chatId and prompt are required" });
  }
  try {
    const answer = await askOpenRouter("You are a helpful villa assistant.", prompt);
    const result = await sendWhatsAppReply({ chatId, text: answer, session });
    res.json({ success: true, prompt, answer, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Competitor Analysis ───────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { location, dates } = req.body;
  if (!location) {
    return res.status(400).json({ error: "location is required" });
  }
  res.json({
    location,
    dates: dates || null,
    competitors: [],
    summary: "Competitor analysis not yet implemented.",
  });
});

// Health
app.get("/health", (_req, res) =>
  res.json({ status: "ok", mcp: mcpClient ? "connected" : "not ready", config: { wahaBaseUrl: CONFIG.wahaBaseUrl, session: CONFIG.wahaSession } })
);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, async () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        WAHA × OpenRouter Bot  •  Port ${CONFIG.port}           ║
╠══════════════════════════════════════════════════════╣
║  POST /webhook       ← WAHA webhook target           ║
║  POST /send          → manual send message           ║
║  POST /ask-and-send  → OpenRouter + send pipeline    ║
║  POST /analyze       → competitor analysis           ║
║  GET  /health        → server status                 ║
╠══════════════════════════════════════════════════════╣
║  WAHA URL  : ${CONFIG.wahaBaseUrl.padEnd(40)}║
║  Session   : ${CONFIG.wahaSession.padEnd(40)}║
╚══════════════════════════════════════════════════════╝
  `);
  try {
    await initMCP();
  } catch (err) {
    console.error("❌ MCP init failed:", err.message);
    process.exit(1);
  }
});
