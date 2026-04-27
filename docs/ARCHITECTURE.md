# ChatPulse Architecture Notes

This document defines the intended shape of the project so new features do not keep accumulating in the largest files.

## Current Shape

ChatPulse is a local-first AI social simulation app:

- `client/`: React + Vite frontend.
- `server/`: Express API, WebSocket runtime, LLM orchestration, memory/RAG, SQLite access, and server plugins.
- `server/plugins/`: optional feature modules that register their own API routes and runtime hooks.
- `scripts/`: repo-level setup, development, migration, and maintenance scripts.
- `config/`: runtime service configuration, currently Qdrant.
- `data/`, `.runtime/`, `server/public/uploads/`: local runtime data and generated files. These should not be treated as source code.

## Desired Boundaries

Keep code moving toward these boundaries:

- HTTP concerns live in route modules, not in domain engines.
- WebSocket broadcasting is an adapter; business logic should receive a notifier interface instead of importing socket state directly.
- LLM prompt construction, LLM calls, response parsing, and persistence should be separate steps.
- Database modules should expose narrow repositories/services instead of one catch-all data access file.
- Plugins own their feature-specific routes, database helpers, UI panels, background jobs, and hooks.
- Shared utilities belong in `server/utils/` or `client/src/utils/`; feature logic should not hide there.

## Server Target Layout

Move gradually toward this layout when touching related code:

```text
server/
  app.js                 # Express app assembly and middleware
  index.js               # process boot, HTTP server, WebSocket server
  config/                # env parsing and runtime constants
  routes/                # thin HTTP route modules
  realtime/              # WebSocket client registry and event broadcasting
  core/
    chat/                # private chat orchestration
    memory/              # memory extraction, search, digest, vector adapters
    characters/          # character profile/state rules
    moments/             # moments API/business rules
  db/
    connection.js
    repositories/        # narrow DB access modules
  plugins/
```

Do not move everything at once. Extract only one seam per PR/change so behavior stays easy to verify.

## Client Target Layout

Move gradually toward this layout:

```text
client/src/
  app/                   # app shell, providers, layout state
  api/                   # fetch clients and endpoint wrappers
  features/
    chat/
    groups/
    characters/
    moments/
    settings/
  plugins/
  shared/
    components/
    hooks/
    utils/
```

Large components should be split by responsibility, not by arbitrary size. For example, `SettingsPanel.jsx` should become settings sections plus API helpers; `App.jsx` should keep app shell state and delegate feature behavior.

## Refactor Priority

1. Extract `server/index.js` route groups into `server/routes/*`. Keep handlers thin and call existing services first.
2. Extract WebSocket client management from `server/index.js` into `server/realtime/wsClients.js`.
3. Split `server/engine.js` into prompt building, RAG planning/retrieval, timer scheduling, tag parsing, and outbound event broadcasting.
4. Split `server/memory.js` into embeddings, vector stores, search/ranking, extraction, digest, and sweep jobs.
5. Split `server/db.js` into repositories by aggregate: users/auth, characters, messages, memories, moments, diaries, debug logs.
6. Split `server/plugins/city/index.js` into routes, tick scheduler, grant actions, social collisions, medical recovery, and hook registration.
7. Split `client/src/App.jsx` into app shell, contact/group selection, realtime event handling, and API clients.
8. Split large frontend panels (`SettingsPanel.jsx`, `ChatSettingsDrawer.jsx`, `GroupChatWindow.jsx`) by screen sections and hooks.

## Guardrails

- Avoid adding new unrelated functions to files already over 500 lines unless the change is a tiny bug fix.
- New backend endpoints should be created in a route module or plugin, then mounted by the app.
- New long-running work should go through a queue/scheduler abstraction, not inline request handlers.
- New LLM behavior should have a named prompt builder and a parser/validator when structured output is expected.
- New plugin code should not reach into another plugin's internal files unless there is an explicit shared service.
- Generated assets, local databases, uploaded files, logs, bundled binaries, and runtime state should not be committed.

## Immediate Smells To Watch

- `server/index.js` mixes boot, middleware, upload handling, route handlers, plugin loading, static serving, and WebSocket setup.
- `server/engine.js` mixes prompt policy, RAG planning, scheduling, LLM debug logging, tag parsing, private chat, and group proactive behavior.
- `server/memory.js` mixes embedding model lifecycle, vector store adapters, memory classification, retrieval ranking, digest generation, extraction, and sweeping.
- `server/db.js` is a broad data access module; adding more tables there increases coupling quickly.
- `server/plugins/city/index.js` is doing plugin boot, route handling, background simulation, LLM event dispatch, and domain rules in one file.
- `client/src/App.jsx` owns too much application orchestration for a React root component.
- `client/src/components/SettingsPanel.jsx` and `ChatSettingsDrawer.jsx` are large feature containers and should be sectionized when touched.
