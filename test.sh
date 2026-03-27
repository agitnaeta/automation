curl --location 'https://openrouter.ai/api/v1/chat/completions' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer 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' \
--header 'HTTP-Referer: https://avail.naetalab.com' \
--header 'X-Title: Avail Room' \
--data '{
  "model": "x-ai/grok-4.1-fast",
  "max_tokens": 1024,
  "provider": {
    "only": ["xAI"],
    "data_collection": "allow",
    "allow_fallbacks": false
  },
  "messages": [
    {
      "role": "system",
      "content": "You are a villa availability assistant."
    },
    {
      "role": "user",
      "content": "Ada villa 2 kamar tidur yang tersedia tanggal 15-20 Maret 2026?"
    }
  ]
}'