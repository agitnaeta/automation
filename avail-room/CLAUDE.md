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

Key tables: guesty_listings, guesty_calendar, guesty_reservations
- guesty_listings: id, title, location, bedrooms, bathrooms, accommodates, min_nights, base_price, currency
- guesty_calendar: date, listing_id, price, status (available|booked), reservation_id
- guesty_reservations: id, listing_id, status, check_in_date, check_out_date (exclude status IN ('confirmed','inquiry','blocked') for availability)

Always use parameterized MCP queries. Never expose service_role on the frontend.
Reply format: WhatsApp only — *bold* and _italic_, no headers, tables, lists, or code blocks.
