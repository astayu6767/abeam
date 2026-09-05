# abeam backend

This repository already had an Express backend for accounts, billing, the
legacy `/api/slots` supervisor, the WebSocket console bridge, and the
conversation engine. It did **not** have the self-contained bot CRUD/runtime
API from `mc-bot-manager`; `/api/slots` only launched an external `BOT_EXE`.

The new bot manager adapts the linked project's `botManager` pattern to this
server:

- a bot definition is persisted in `data/bots.json`;
- a runtime is kept in memory and resumed when `enabled`;
- Mineflayer connects using the supplied Minecraft bearer/access token;
- status, logs, console chat, inventory actions, movement, view snapshots, and
  Beam conversations are exposed through API routes;
- bot records are scoped to the signed-in account and bot creation is limited
  by the account's active plan slots;
- tokens are accepted on create/update but are never included in API JSON
  responses.

The manager currently uses the `mineflayer` engine. The older `/api/slots`
path remains available for the repository's external `abeam.exe`/WebSocket
workflow.

## Bot API

All bot routes require the existing web session cookie or an SSID bearer token:

```http
Authorization: Bearer YOUR_SSID
```

The account must have an active plan with an available bot slot, unless the
request is from an admin.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/bots` | List the caller's bots and slot usage |
| `POST` | `/api/bots` | Create and asynchronously start a bot |
| `GET` | `/api/bots/:id` | Get one bot (token is masked/omitted) |
| `PATCH` | `/api/bots/:id` | Update configuration; active bots restart |
| `DELETE` | `/api/bots/:id` | Stop and delete a bot |
| `POST` | `/api/bots/:id/start` | Enable and start a bot |
| `POST` | `/api/bots/:id/stop` | Disable and stop a bot |
| `GET` | `/api/bots/:id/console` | Runtime status, logs, and Beam state |
| `POST` | `/api/bots/:id/console` | Send a Minecraft chat message |
| `GET` | `/api/bots/:id/view` | Runtime status and a view/inventory snapshot |
| `POST` | `/api/bots/:id/action` | Movement, inventory, Beam actions |

Create example:

```bash
curl -X POST "$APP_URL/api/bots" \
  -H "Authorization: Bearer $SSID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my bot",
    "token": "MINECRAFT_BEARER_TOKEN",
    "host": "play.example.net",
    "port": 25565,
    "version": "auto",
    "proxy": "socks5://user:pass@proxy.example.net:1080",
    "antiAfk": true,
    "antiAfkInterval": 120
  }'
```

The token must be a valid Minecraft bearer/access token. Do not send a
Microsoft/Minecraft password to this API. `PATCH` can replace the token and
will restart a running bot.

`POST /api/bots/:id/action` accepts these action bodies:

```json
{"action":"move","dir":"forward"}
{"action":"select","slot":3}
{"action":"use"}
{"action":"drop"}
{"action":"clickWindow","slot":13}
{"action":"closeWindow"}
{"action":"beam","target":"PlayerName"}
{"action":"beam_stop"}
```

## Local development

```bash
npm ci
cp .env.example .env
npm start
# health: http://localhost:8080/healthz
```

The JSON files in `data/` are the development datastore. Do not run more than
one application replica against the same JSON files. For production, mount a
Railway volume at `/app/data`.

## Railway deployment

The repository includes `Dockerfile`, `railway.json`, and a `/healthz`
healthcheck. No Postgres service is required by this version because the
existing application uses its JSON store; a persistent volume is required if
accounts, invoices, sessions, and bot definitions must survive deploys.

1. Push or keep this repository on the `arena/01a070c3-abeam` branch.
2. In Railway, choose **New Project → Deploy from GitHub repo**, select the
   repository, and set the service branch to `arena/01a070c3-abeam`.
3. Add a Railway **Volume** to the web service and mount it at:

   ```text
   /app/data
   ```

   Keep one web replica. Mineflayer bot connections are process-local.
4. Deploy. Railway detects the `Dockerfile`; the container runs `npm start`.
   Wait for `/healthz` to pass, then use **Settings → Networking → Generate
   Domain**.
5. Add these service variables before using production accounts:

   ```text
   NODE_ENV=production
   APP_URL=https://YOUR-DOMAIN.up.railway.app
   SESSION_SECRET=<long random value>
   ADMIN_EMAILS=your-admin-email@example.com
   ADMIN_TOKEN=<separate random admin API token>
   ```

   Generate a secret locally with `openssl rand -hex 32`. Railway supplies
   `PORT`; do not hard-code a public port.
6. If using Discord login, set `DISCORD_CLIENT_ID` and
   `DISCORD_CLIENT_SECRET`, then add this exact redirect in the Discord
   Developer Portal:

   ```text
   https://YOUR-DOMAIN.up.railway.app/login/discord/callback
   ```

7. If using LTC billing, also configure `LTC_SEED`, `LTC_NETWORK`,
   `BLOCKCYPHER_TOKEN` (if required), `LTC_USD_RATE`, and
   `LTC_CONFIRMATIONS`. Keep the seed in Railway Variables, never in Git.
8. Keep the Railway service on an always-on plan. Sleeping/restarting the
   service disconnects Minecraft clients; enabled bot records reconnect after a
   restart, but they cannot stay connected while the service is asleep.

### Important production notes

- `data/` contains account/session/billing state and bot access tokens. Protect
  the Railway volume and rotate any token that was exposed. A managed database
  should replace the JSON store before running multiple replicas.
- `ALLOW_DEMO` is hard-disabled when `NODE_ENV=production`; do not rely on the
  demo account in Railway.
- A Minecraft access token can expire. Update it through `PATCH /api/bots/:id`
  rather than putting it in a dashboard response or log.
- The linked `mc-bot-manager` branch compiles an Azalea Rust sidecar. This
  adaptation intentionally uses Mineflayer so this backend deploys with the
  regular Node Docker image; the existing legacy executable path is still
  available when an Azalea/abeam binary is supplied separately.
