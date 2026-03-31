

# ChatPulse

ChatPulse is a local-first AI social simulation app built with React, Express, SQLite, WebSocket realtime updates, and optional Qdrant-backed memory retrieval.

中文说明见 [README.zh-CN.md](./README.zh-CN.md)。

## Stack

- Frontend: React 19 + Vite
- Backend: Node.js + Express + ws
- Primary app storage: SQLite via `better-sqlite3`
- Vector search: Qdrant when available
- Local vector fallback: vectra + `@xenova/transformers`

## Local Deployment

### Requirements

- Node.js 18 or newer
- npm 9 or newer
- Optional: Docker Desktop if you want Qdrant in a container

### 1. Clone

```bash
git clone https://github.com/NANA3333333/no.git
cd ChatPulse
```

### 2. Bootstrap the workspace

```bash
npm run setup
```

Windows one-click install and start:

```bat
install-and-start.cmd
```

macOS / Linux one-click install and start:

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

What this does:

- installs root, server, and client dependencies
- creates local runtime directories
- creates `server/.env` from `server/.env.example` if it does not exist
- prepares folders that are intentionally excluded from Git

### 3. Configure local env

Review `server/.env` and update it as needed.

Important values:

- `ADMIN_PASSWORD`: recommended so first login is predictable
- `QDRANT_ENABLED`: leave as `1` unless you explicitly want vectra-only mode
- `QDRANT_URL`: default is `http://127.0.0.1:6333`

### 4. Start the app

Cross-platform:

```bash
npm run dev
```

Windows helper scripts:

```bat
install-and-start.cmd
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

macOS / Linux helper script:

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

App URLs:

- Frontend: [http://127.0.0.1:5173](http://127.0.0.1:5173)
- Backend: [http://localhost:8000](http://localhost:8000)

### 5. First login

On a fresh auth database, ChatPulse auto-seeds a root user:

- username: `Nana`
- password: `12345` by default

If you set `ADMIN_PASSWORD` in `server/.env`, that value becomes the seeded root password for a brand-new auth database.

## Databases, Cache, and Vector Initialization

Fresh clones do not need committed runtime data.

These are created automatically on first start:

- `data/master.db` for auth
- `data/chatpulse_user_<id>.db` per user
- `server/public/uploads/`
- local vectra indices under `data/vectors/...`
- JWT secret file when not supplied by env

Qdrant behavior:

- If Qdrant is reachable, the server uses it as the primary vector backend.
- If Qdrant is unavailable, the server automatically falls back to local vectra indices.
- Qdrant collections are created lazily when memory points are first written.

That means a new contributor can boot the project without Qdrant and still use the app locally.

## Optional Qdrant Setup

Start Qdrant with Docker:

```bash
docker compose up -d
```

If you already have memories in SQLite/vectra and want to backfill them into Qdrant:

```bash
npm run migrate:qdrant
```

Useful variants:

```bash
npm run migrate:qdrant -- --dry-run
npm run migrate:qdrant -- --user <userId>
npm run migrate:qdrant -- --character <characterId>
```

## Health Check

Run:

```bash
npm run doctor
```

This checks:

- Node version
- installed dependencies
- local runtime directories
- `server/.env`
- Qdrant reachability

## Useful Commands

```bash
npm run setup
npm run dev
npm run doctor
npm run migrate:qdrant
npm run cleanup:city-memories
```

## Project Structure

```text
client/
  src/

server/
  index.js
  db.js
  memory.js
  qdrant.js
  plugins/

scripts/
  setup-local.js
  doctor.js
  dev.js
  migrate-memories-to-qdrant.js
```

## Notes for Contributors

- Runtime data is intentionally gitignored.
- A fresh clone should be considered empty-state and bootstrapped locally.
- The backend loads `server/.env` automatically on startup.

## License

ISC
