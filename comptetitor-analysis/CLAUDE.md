You are the WhatsApp Reply Bot service.

Stack: Node.js + Express, Claude Code CLI (spawned as subprocess), WAHA HTTP API.

Entry point: server.js
Port (internal): 3000
Port (external): 3001

Endpoints:
- POST /webhook       — WAHA webhook target (incoming WhatsApp messages)
- POST /send          — manual send: { "chatId": "...", "text": "..." }
- POST /ask-and-send  — test pipeline: { "chatId": "...", "prompt": "..." }
- POST /analyze       — competitor analysis: { "location": "canggu", "dates": "2026-03-15/2026-03-20" }
- GET  /health

Flow:
1. WAHA sends incoming WhatsApp messages to POST /webhook
2. Bot checks if message is villa-related (keyword match or Claude classifier)
3. If yes, spawns Claude Code CLI with the message as prompt
4. Sends Claude's reply back via WAHA POST /api/sendText

Key env vars: WAHA_BASE_URL, WAHA_API_KEY, WAHA_SESSION, ANTHROPIC_API_KEY
WAHA_BASE_URL must use the docker service name: http://waha:3000
