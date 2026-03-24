You are an automation system for a villa rental business, built on Docker Compose.
All custom modules are Node.js (ES modules, Express).

# Services & Ports

| Service    | Folder        | External Port | Internal Port | Description                          |
|------------|---------------|---------------|---------------|--------------------------------------|
| caddy      | —             | 80 / 443      | —             | Reverse proxy for all services       |
| n8n        | —             | 5678          | 5678          | Workflow automation                  |
| redash     | —             | 5001          | 5000          | Analytics dashboard                  |
| waha       | —             | 3000          | 3000          | WhatsApp HTTP API                    |
| reply      | ./reply       | 3001          | 3000          | WhatsApp bot + competitor analysis   |
| avail-room | ./avail-room  | 8100          | 3000          | Villa availability API               |

# Custom Modules

## reply (port 3001)
WhatsApp bot that listens to WAHA webhooks and replies using Claude Code CLI.
Also hosts the competitor analysis endpoint.

Endpoints:
- POST /webhook       — receives incoming WhatsApp messages from WAHA
- POST /send          — manually send a WhatsApp message
- POST /ask-and-send  — send a prompt to Claude then forward reply to WhatsApp
- POST /analyze       — competitor analysis stub: { location, dates }
- GET  /health

Key env vars: WAHA_BASE_URL=http://waha:3000, WAHA_API_KEY, ANTHROPIC_API_KEY

## avail-room (port 8100)
Parses natural language villa availability queries via Claude, then queries Supabase.

Endpoints:
- POST /availability  — body: { "message": "Available 2BR villas March 15-20?" }
                        returns: { "reply": "<whatsapp formatted>", "villas": [...] }
- GET  /health

Flow: Claude extracts intent (dates, bedrooms, location) → Supabase query on
listings / rooms / addresses / pricing / reservations tables → WhatsApp-formatted reply.

Key env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# Infrastructure

- docker-compose.yml  — defines all services, env injection, volumes, port bindings
- Caddyfile           — reverse proxy rules (domain → service:port)
- .env                — single source of truth for all environment variables

# Environment Variables (root .env)
All services read from the root .env — no per-module .env files.
For local dev outside Docker: symlink with `ln -s ../.env .env` from module folder.

Key variable groups:
- ANTHROPIC_API_KEY          — Claude API key (shared by reply + avail-room)
- SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — Supabase REST (avail-room)
- SUPABASE_DB_*              — Postgres connection (n8n + redash)
- WAHA_API_KEY / WAHA_SESSION — WAHA auth (waha + reply)
- N8N_* / REDASH_*           — service-specific config
- TIMEZONE                   — Asia/Jakarta (all services)
