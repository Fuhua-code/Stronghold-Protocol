# Stronghold TURN Broker

This directory is the isolated Vercel project root. Import the repository in Vercel and set **Root Directory** to `vercel-turn-broker`.

Runtime: Node.js 22.x. Configure these Vercel Production environment variables:

- `CLOUDFLARE_TURN_API_TOKEN`
- `CLOUDFLARE_TURN_KEY_ID`
- `TURN_ALLOWED_ORIGINS=https://fuhua-code.github.io`

Endpoints:

- `GET /api/turn/healthz` reports non-secret deployment status.
- `GET /api/turn/credentials?ttl=600` returns validated short-lived ICE credentials for the allowed Pages origin.

This project does not host the game, static assets, rooms, or WebSocket signaling. Never put Cloudflare credentials in source files or build output.
