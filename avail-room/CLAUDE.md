You are the Villa Availability API service.

Stack: Node.js + Express, Claude Code CLI (spawned as subprocess), Supabase via MCP.

Entry point: server.js
Port (internal): 3000
Port (external): 8100

Endpoints:
- POST /availability  — body: { "message": "..." }, returns { "reply": "..." }
- GET  /health

Flow:
1. Express receives a natural language availability query
2. Claude Code CLI is spawned with a prompt containing the query
3. Claude uses MCP Supabase to parse intent + query the database
4. Returns a WhatsApp-formatted reply (only *bold* and _italic_ allowed)

Key tables: listings, rooms, addresses, pricing, reservations
- listings: id, name, status (filter: status = 'active')
- rooms: listing_id, bedrooms
- addresses: listing_id, city
- pricing: listing_id, price_per_night, currency
- reservations: listing_id, check_in, check_out, status (confirmed/inquiry/blocked)

Always use parameterized MCP queries. Never expose service_role on the frontend.
Reply format: WhatsApp only — *bold* and _italic_, no headers, tables, lists, or code blocks.
