import express from "express";
import { spawn } from "child_process";
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
  claudeTimeoutMs: parseInt(process.env.CLAUDE_TIMEOUT_MS || "60000"),
};

// ─── Claude Code CLI ──────────────────────────────────────────────────────────
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--dangerously-skip-permissions"];
    const proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${CONFIG.claudeTimeoutMs / 1000}s`));
    }, CONFIG.claudeTimeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Claude exited code ${code}: ${stderr.trim()}`));
    });

    proc.on("error", (err) =>
      reject(new Error(`Failed to spawn Claude: ${err.message}`))
    );
  });
}

async function isVillaContext(text) {
  // Quick local fallback check for explicit keywords
  const low = (text || "").toLowerCase();
  const explicit = ["villa", "villa booking", "villa availability", "villas", "villa rental", "villa price", "villa stay"].some((k) => low.includes(k));
  if (explicit) return true;

  // Use Claude as context classifier when text isn't clearly explicit.
  try {
    const prompt = `You are a strict context classifier. Reply with ONLY one word: yes or no.\nIs this WhatsApp message from a customer about a villa listing, villa booking, villa availability, or villa property details?\nMessage: "${text.replace(/\"/g, "\\\"")}"`;
    const result = await runClaude(prompt);
    const normalized = (result || "").trim().toLowerCase();
    if (/^yes/.test(normalized)) return true;
    if (/^no/.test(normalized)) return false;
    // fallback: if uncertain, default false to avoid unwanted replies
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

  // Handle known non-message events for logging
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

  // WAHA sends different event types — we only care about incoming messages
  // Supported event: message, message.any
  // Skip messages sent by us (fromMe)
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

  // Extract text content
  const text =
    payload?.body ||                          // standard text
    payload?.message?.conversation ||         // some versions
    payload?.message?.extendedTextMessage?.text ||
    payload?.message?.conversation;

  if (!text || typeof text !== "string") return null;

  const chatId =
    payload?.key?.remoteJid ||
    payload?.from ||
    payload?.chatId;

  const allowedSuffixes = ["8161", "0334","6780"];
  const normalizedId = (chatId || "").toString();
  const senderNumber = normalizedId.replace(/[^0-9]/g, "");
  const isAllowed = true; // For testing, allow all numbers. To restrict, use: allowedSuffixes.some(suffix => senderNumber.endsWith(suffix));
  if (!isAllowed) {
    return {
      event,
      type: "ignored_number",
      chatId,
      senderNumber,
      text,
    };
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

  // Acknowledge immediately so WAHA doesn't retry
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
    console.log(
      `[${requestId}] 🔁 Session status event (${msg.session}) from ${msg.chatId}: ${msg.status}`
    );
    return;
  }

  if (msg.type === "ignored_number") {
    console.log(
      `[${requestId}] ⏭  Ignored number ${msg.senderNumber} from chatId ${msg.chatId}. Only endings 8161/0334 are processed.`
    );
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
    // Ask Claude
    console.log(`[${requestId}] 🤖 Sending to Claude...`);
    const claudeReply = await runClaude(msg.text);
    console.log(`[${requestId}] ✅ Claude replied: "${claudeReply.slice(0, 120)}..."`);

    // Send reply back via WAHA
    const replyTo = msg.messageId
      ? `${msg.chatId}_${msg.messageId}`
      : null;

    await sendWhatsAppReply({
      chatId: msg.chatId,
      replyTo,
      text: claudeReply,
      session: msg.session,
    });

    console.log(`[${requestId}] 📤 Reply sent to ${msg.chatId}`);
  } catch (err) {
    console.error(`[${requestId}] ❌ Error:`, err.message);

    // Optionally send error notice back to chat
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

// ─── Manual send endpoint (for testing) ───────────────────────────────────────
// POST /send  { "chatId": "...", "text": "...", "replyTo": "..." }
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

// ─── Manual ask + send (test Claude → WhatsApp pipeline) ──────────────────────
// POST /ask-and-send  { "chatId": "...", "prompt": "..." }
app.post("/ask-and-send", async (req, res) => {
  const { chatId, prompt, session } = req.body;
  if (!chatId || !prompt) {
    return res.status(400).json({ error: "chatId and prompt are required" });
  }

  try {
    const answer = await runClaude(prompt);
    const result = await sendWhatsAppReply({ chatId, text: answer, session });
    res.json({ success: true, prompt, answer, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Competitor Analysis ──────────────────────────────────────────────────────
// POST /analyze  { "location": "canggu", "dates": "2026-03-15/2026-03-20" }
app.post("/analyze", async (req, res) => {
  const { location, dates } = req.body;
  if (!location) {
    return res.status(400).json({ error: "location is required" });
  }

  // TODO: implement competitor scraping / analysis logic
  // e.g. scrape Airbnb, Booking.com, or call a pricing API for the given location + dates
  res.json({
    location,
    dates: dates || null,
    competitors: [],
    summary: "Competitor analysis not yet implemented.",
  });
});

// Health
app.get("/health", (_req, res) =>
  res.json({ status: "ok", config: { wahaBaseUrl: CONFIG.wahaBaseUrl, session: CONFIG.wahaSession } })
);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        WAHA × Claude Bot  •  Port ${CONFIG.port}              ║
╠══════════════════════════════════════════════════════╣
║  POST /webhook       ← WAHA webhook target           ║
║  POST /send          → manual send message           ║
║  POST /ask-and-send  → Claude + send pipeline test   ║
║  POST /analyze       → competitor analysis           ║
║  GET  /health        → server status                 ║
╠══════════════════════════════════════════════════════╣
║  WAHA URL  : ${CONFIG.wahaBaseUrl.padEnd(40)}║
║  Session   : ${CONFIG.wahaSession.padEnd(40)}║
╚══════════════════════════════════════════════════════╝
  `);
});
