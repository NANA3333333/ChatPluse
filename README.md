
# ChatPulse

> [!IMPORTANT]
> **2026-04-05 最新修复说明**
> - 修掉了私聊里 RAG `retrieve` 阶段会卡死的问题，根因是聊天链里不该现场自愈重建索引。
> - 实时聊天链默认不再让本地 `vectra` 参与自动回退，当前主路径是 `Qdrant + SQLite 正文 + lexical/semantic fallback`。
> - 关闭了默认的额外检索查询扩展步骤，不再在检索前额外绕一层小模型加工。
> - 放松了 `profile` 槽过滤，轻度关系化的用户画像记忆不再被白白筛掉。
> - 连续相同的 API 报错现在会在私聊里合并显示，不再一条一条刷屏。
> - 商业街管理员赠送物品/钱/体力现在会按正常私聊链触发角色反馈并进入后续上下文。
>
> 详细说明见下方中文的“**2026-04-05 修复记录**”和英文的 “**2026-04-05 Fix Notes**”。

<p align="center">
  <a href="#简体中文">简体中文</a> |
  <a href="#english">English</a>
</p>

## 简体中文

ChatPulse 是一个本地优先的 AI 社交模拟应用，前端使用 React，后端使用 Express，主存储为 SQLite，并支持接入 Qdrant 做向量记忆检索。

### 技术栈

- 前端：React 19 + Vite
- 后端：Node.js + Express + ws
- 主存储：SQLite（`better-sqlite3`）
- 向量检索：Qdrant
- 本地兜底索引：vectra + `@xenova/transformers`

### 本地部署

环境要求：

- Node.js 18+
- npm 9+
- 可选：Docker Desktop（如果你想本地跑 Qdrant）

克隆仓库：

```bash
git clone https://github.com/NANA3333333/ChatPluse.git
cd ChatPulse
```

初始化：

```bash
npm run setup
```

Windows 一键安装并启动：

```bat
install-and-start.cmd
```

macOS / Linux 一键安装并启动：

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

`npm run setup` 会自动：

- 安装根目录、`server`、`client` 依赖
- 创建本地运行目录
- 自动生成 `server/.env`（如果不存在）
- 创建运行所需但不会提交到 Git 的目录

启动：

```bash
npm run dev
```

Windows 辅助脚本：

```bat
install-and-start.cmd
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

macOS / Linux 辅助脚本：

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

启动后访问：

- 前端：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端：[http://localhost:8000](http://localhost:8000)

首次登录：

- 用户名：`Nana`
- 默认密码：`12345`

如果你在 `server/.env` 中设置了 `ADMIN_PASSWORD`，那么全新初始化时会使用你设置的密码。

### 数据库、缓存与向量库初始化

首次启动时会自动创建：

- `data/master.db`：认证库
- `data/chatpulse_user_<id>.db`：每个用户自己的业务数据库
- `server/public/uploads/`：上传目录
- `data/vectors/...`：本地 vectra 索引目录
- JWT secret 文件（如果环境变量未提供）

Qdrant 行为：

- Qdrant 可用时，优先使用 Qdrant
- Qdrant 不可用时，自动回退到本地 vectra
- Qdrant collection 会在首次写入记忆时自动创建

所以即使没有启动 Qdrant，项目也能在本地正常跑起来。

可选启动 Qdrant：

```bash
docker compose up -d
```

将已有记忆迁移到 Qdrant：

```bash
npm run migrate:qdrant
```

常用参数：

```bash
npm run migrate:qdrant -- --dry-run
npm run migrate:qdrant -- --user <userId>
npm run migrate:qdrant -- --character <characterId>
```

健康检查：

```bash
npm run doctor
```

常用命令：

```bash
npm run setup
npm run dev
npm run doctor
npm run migrate:qdrant
npm run cleanup:city-memories
```

项目结构：

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

### 许可证

本项目采用 **CC BY-NC-ND 4.0** 许可。

这意味着：

- 允许转载和分享
- 必须注明作者 `NANA3333333 / Nana` 以及原始仓库链接
- 禁止商用
- 禁止修改后再发布

完整许可说明见 [LICENSE](./LICENSE) 和 [Creative Commons 官方页面](https://creativecommons.org/licenses/by-nc-nd/4.0/)。

---

## English

ChatPulse is a local-first AI social simulation app built with React, Express, SQLite, WebSocket realtime updates, and optional Qdrant-backed memory retrieval.

### Stack

- Frontend: React 19 + Vite
- Backend: Node.js + Express + ws
- Primary storage: SQLite via `better-sqlite3`
- Vector search: Qdrant
- Local fallback index: vectra + `@xenova/transformers`

### Local Setup

Requirements:

- Node.js 18+
- npm 9+
- Optional: Docker Desktop if you want to run Qdrant locally

Clone:

```bash
git clone https://github.com/NANA3333333/ChatPluse.git
cd ChatPulse
```

Bootstrap:

```bash
npm run setup
```

One-click install and start on Windows:

```bat
install-and-start.cmd
```

One-click install and start on macOS / Linux:

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

`npm run setup` will:

- install root, `server`, and `client` dependencies
- create local runtime directories
- generate `server/.env` if it does not exist
- prepare runtime-only folders that are intentionally excluded from Git

Start the app:

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

URLs:

- Frontend: [http://127.0.0.1:5173](http://127.0.0.1:5173)
- Backend: [http://localhost:8000](http://localhost:8000)

First login:

- Username: `Nana`
- Default password: `12345`

If you set `ADMIN_PASSWORD` in `server/.env`, that value will be used for first-run seeding on a brand-new auth database.

### Databases, Cache, and Vector Initialization

On first startup, the project automatically creates:

- `data/master.db` for auth
- `data/chatpulse_user_<id>.db` per user
- `server/public/uploads/`
- local vectra indices under `data/vectors/...`
- a JWT secret file when not provided by env

Qdrant behavior:

- Uses Qdrant when reachable
- Real-time private/group chat RAG no longer depends on local vectra as an automatic fallback by default
- Creates Qdrant collections lazily on first memory write

So the project is still runnable locally, but real-time memory retrieval is now expected to have Qdrant available.

### 2026-04-05 Fix Notes

Today’s work focused on the Claude private-chat path, the RAG retrieval pipeline, and a few front-end UX regressions:

- Removed chat-time self-healing index rebuilds from the live retrieval path. Previously, a normal private-chat request could enter `retrieve`, decide the index looked unhealthy, and start rebuilding during the reply, which caused long hangs and heavy local CPU usage.
- Disabled vectra in the real-time retrieval path by default. The current live path is effectively `Qdrant + SQLite memory content + lexical/semantic fallback`. Local vectra is now opt-in only via `LOCAL_VECTOR_INDEX_ENABLED=1`.
- Disabled the extra “expand retrieval queries with another LLM call” step by default. It can still be re-enabled with `MEMORY_QUERY_EXPANSION_ENABLED=1`, but it no longer slows down the standard retrieval path out of the box.
- Added finer-grained retrieval tracing so logs now show retrieve start/end, per-slot progress, Qdrant query phases, and fallback phases. This makes it much easier to tell whether a request is stuck in topics, rewrite, retrieve, or main output.
- Added `GET /api/system/embedding-status` to inspect the local `bge-m3` embedding runtime: loaded state, active jobs, recent latency, and errors.
- Relaxed profile-slot filtering so lightly relationship-tinted user-profile memories can still be injected. This fixes a case where valid profile memories were being retrieved and then discarded because they mentioned possessiveness, teasing style, or interaction habits.
- City-manager gifting / money / stamina actions now go through the normal private-chat chain and can generate ordinary in-character feedback that becomes part of later conversation context.
- Expanded the private/group emoji picker, fixed the temporary `??` encoding regression, and kept the wider popup layout.
- Consecutive identical system API errors in private chat are now collapsed into a single visible message with a repeat count, instead of spamming multiple identical red bubbles.

Notes:

- Recent Claude `503 model_not_found / no available channel` failures look like upstream relay/channel issues, not local RAG hangs.
- SQLite stores memory content, while Qdrant stores vector indices. The main issue uncovered today was not lost memory text; it was an unstable “index state check + self-heal during live chat” design.

Optional Qdrant startup:

```bash
docker compose up -d
```

Migrate existing memories into Qdrant:

```bash
npm run migrate:qdrant
```

Common options:

```bash
npm run migrate:qdrant -- --dry-run
npm run migrate:qdrant -- --user <userId>
npm run migrate:qdrant -- --character <characterId>
```

Health check:

```bash
npm run doctor
```

Useful commands:

```bash
npm run setup
npm run dev
npm run doctor
npm run migrate:qdrant
npm run cleanup:city-memories
```

### License

This project is licensed under **CC BY-NC-ND 4.0**.

That means:

- sharing and redistribution are allowed
- attribution to `NANA3333333 / Nana` and the original repository is required
- commercial use is not allowed
- modified redistribution is not allowed

See [LICENSE](./LICENSE) and the [official Creative Commons page](https://creativecommons.org/licenses/by-nc-nd/4.0/) for details.
