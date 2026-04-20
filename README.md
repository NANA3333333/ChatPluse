
# ChatPulse

> [!IMPORTANT]
> **2026-04-12 中文版补充更新说明**
> - 输入前链新增并稳定了“切题判断”层，当前私聊主链路为 `摘要 -> 切题 -> 路由 -> 主题 -> 决策 -> 改写 -> 召回 -> 输出`。
> - 前端 RAG 流程条与设置面板已同步显示切题判断结果，现在可以直接看到上一轮是“切题 / 继续当前话题 / 历史追问”。
> - 日期回顾链路继续加强：支持按日期浏览、分块摘要、上下文分区，并修复了强热点话题污染日期回顾的问题。
> - 输入前链与路由层的输出上限整体放宽到更安全的范围，专门缓解上游中转在短结构化步骤里偷偷消耗大量 reasoning token、导致结果被截断的问题。
> - 输入前链请求增加了节流和按中转限速自适应的排队，尽量减少 `429` 和连续 planner 报错。
> - 商业街自动行动如果遇到 API 失败，现在会直接取消本轮行动并写入折叠错误日志，不再强制把角色随机丢到别的地点。
> - 商业街主动私聊提示词改成“事件驱动主动”，保留主动性，但不再默认用“你在干嘛 / 你在哪 / 在吗”这类空泛开头。
> - 时间行为约束进一步加强：白天语境优先级高于话题惯性，减少角色在白天还顺着旧话题继续催用户睡觉的情况。
> - 当前 README 关于实时记忆架构的说明保持为现行实现：`Qdrant + SQLite 正文/元数据`，不再把旧的 `vectra` 路径写成主链路。

> [!IMPORTANT]
> **2026-04-06 中文版更新说明**
> - 黑客据点现在会抓取用户过去 5 小时内与其他角色的真实私聊记录，按最近对话对象分配最多 20 条情报，并把这些对话作为“花钱买来的监听反馈”临时注入角色上下文；角色会按正常私聊/RAG链路自己做出带情绪的回应，而不是输出硬编码汇报。
> - 后端重后台任务改成统一走后台队列，并加了全局并发上限，解决了之前多计时器叠在一起把前台请求拖成“空壳”的问题。
> - 商业街分钟巡逻、角色自主行动、社交碰撞、私聊主动消息、群聊主动消息都已经按层恢复，并在恢复过程中做了稳定性回归。
> - 大设置里新增了“后台任务队列”面板，现在可以看到真实队列状态、最近 24 小时任务历史，并按角色、群聊或商业街系统折叠显示。
> - 商业街截断日志处理已经补上：疑似被截断的商业街活动会对角色隐藏，对用户显示为低存在感的折叠提示。
> - 医院恢复逻辑改成住院期间每 5 分钟结算一次，不再是原来一次性瞬间恢复。
> - 私聊到商业街的路由提示词进一步收紧：地点、去向、吃什么、送礼/收礼、现实状态来源这类问题会更偏向查询商业街。
> - “上一轮是否路由到商业街内容”这行统计已经修正，现在会正确识别 `city_detail`，不再出现实际走了商业街但面板还显示“否”的情况。
> - 修了一批前端问题，包括登录和重置本地界面状态卡住、`127.0.0.1:5173` 与 `127.0.0.1:8000` 地址不一致、联系人列表排版和后台任务面板可读性问题。

> [!IMPORTANT]
> **2026-04-05 最新修复说明**
> - 修掉了私聊里 RAG `retrieve` 阶段会卡死的问题，根因是聊天链里不该现场自愈重建索引。
> - 实时聊天链默认不再让本地 `vectra` 参与自动回退，当前主路径是 `Qdrant + SQLite 正文 + lexical/semantic fallback`。
> - 保留了检索前的查询扩展设计，只修掉了会把实时链路拖死的部分。
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

### 缓存、RAG 与向量记忆科普

如果你是第一次接触这些词，可以先把它们理解成四个分工不同的层：

- 缓存：把已经整理好的上下文、摘要或模型结果先存起来，避免每一轮都从零重算。
- SQLite：负责保存完整消息、记忆正文和业务元数据，像项目里的“资料库”。
- Qdrant：负责按语义相近去找相关记忆，像项目里的“智能检索柜”。
- RAG：不是让模型硬猜，而是先把相关历史资料找回来，再基于这些资料回答。

一句话概括就是：缓存让它更快，SQLite 负责存原文，Qdrant 负责按语义把过去找回来，RAG 负责先查再答。

### 技术栈

- 前端：React 19 + Vite
- 后端：Node.js + Express + ws
- 主存储：SQLite（`better-sqlite3`）
- 向量检索：Qdrant
- 实时记忆主路径：Qdrant + SQLite 正文/元数据

### 本地部署

环境要求：

- Node.js 18+
- npm 9+
- 可选：Docker Desktop（如果你想本地跑 Qdrant）

克隆仓库：

```bash
git clone https://github.com/NANA3333333/ChatPluse.git
cd ChatPluse
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
- JWT secret 文件（如果环境变量未提供）

Qdrant 行为：

- Qdrant 可用时，实时记忆检索优先使用 Qdrant
- Qdrant collection 会在首次写入记忆时自动创建
- SQLite 持续保存完整消息、记忆正文和元数据

当前 README 描述的现行实时链路以 `Qdrant + SQLite 正文/元数据` 为主。

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

### City 模块结构说明

`server/plugins/city` 现在不再只是一个“所有逻辑都堆在 `index.js`”里的单文件插件，而是逐步拆成了“入口编排 + 数据层 + service 层”。

当前目录结构：

```text
server/plugins/city/
  index.js
  cityDb.js
  services/
    actionService.js
    mayorService.js
    mayorRuntimeService.js
    questService.js
    socialService.js
```

职责划分：

- `index.js`
  仍然是 city DLC 的入口文件。
  负责：
  - 挂载 `/api/city/*` 路由
  - 初始化依赖和上下文
  - 组装各个 service
  - 保留插件入口和外部调用形状

- `cityDb.js`
  是 city 的数据访问层。
  负责：
  - `city_*` 相关表结构
  - 任务、公告、日志、库存、地点、配置等读写
  - 给上层 service 提供稳定的数据操作接口

- `services/actionService.js`
  是“商业街行动执行器”。
  负责：
  - 角色到某个地点后这次行动怎么结算
  - 体力、金币、状态变化
  - 赌博、购物、进食、医疗、学习等分支行为
  - 行动后的广播、任务推进、钱包同步

- `services/questService.js`
  是“公告任务推进与结算器”。
  负责：
  - 领取任务后的推进
  - 汇报 / 交付阶段判断
  - 任务完成与失败结算
  - 任务结果文案生成

- `services/mayorService.js`
  是“市长 AI 业务能力层”。
  负责：
  - 市长模型选择
  - 市长 JSON 输出解析
  - 任务难度评分
  - 任务推进评分
  - 市长决策结果落库

- `services/mayorRuntimeService.js`
  是“市长 AI 运行时编排层”。
  负责：
  - 是否到达自动执行时间
  - 本轮市长 AI 是否允许执行
  - 调用市长模型生成事件/任务/广播
  - fallback 决策和运行锁

- `services/socialService.js`
  是“同地点社交遭遇结算器”。
  负责：
  - 角色同地点碰撞检测
  - 社交冷却
  - 多角色顺序发言模拟
  - 社交结果总结
  - 好感 / 印象 / 私聊 / 朋友圈 / 日记更新

为什么这样拆：

- 原先 `city/index.js` 同时承担了：
  - 路由
  - 运行时调度
  - 市长 AI
  - 公告任务
  - 商业街行动
  - 社交遭遇
  - 文案生成
- 这种结构在功能变多后很容易让一个需求改动牵动整块文件。
- 现在的拆分目标不是“一次性大重构”，而是先把最重、最容易继续膨胀的业务块独立出来，让 `index.js` 更像编排层。

当前推荐理解方式：

1. `index.js` 是 city 插件入口。
2. `cityDb.js` 是 city 的持久化层。
3. `services/*` 是真正的业务层。
4. 新功能如果属于某个明确领域，优先继续放进对应 service，而不是再直接堆回 `index.js`。

后续继续拆分时，推荐顺序：

- `routes/`
  把 `/api/city/*` 路由从 `index.js` 拆成独立路由文件
- `scheduleService`
  把日程生成和时段计划逻辑单独抽出
- 更细的 action 子模块
  例如把购物 / 医疗 / 赌博拆成 `actionService` 内部子文件

目前这套结构的目标不是“绝对完美”，而是：

- 保持现有功能继续可用
- 让新增需求不再持续把 `index.js` 养成单文件巨兽
- 让独立开发时也能靠模块边界维持可读性

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

### 2026-04-12 Update Notes

This update focused on topic switching, date recall stability, and cleaning up stale architecture notes:

- Added a dedicated topic-switch gate before the existing RAG route stage. The live pipeline is now `Summary -> Switch -> Route -> Topics -> Decision -> Rewrite -> Retrieve -> Output`.
- Synced the front-end RAG progress header and settings drawer so the last round can explicitly show `Switch topic`, `Continue current topic`, or `History follow-up`.
- Hardened the date-recall path with date-browse routing, chunked day summaries, context partitioning, and better cache invalidation for polluted strong-topic lines.
- Prevented malformed / truncated outputs from pre-planner stages (`topic switch`, `topics`, `decision`, and `temporal browse summarize`) from being reused from cache.
- Changed the topic-switch gate to fail closed: if that layer breaks, the turn now stops immediately and returns an error instead of silently falling back to `continue current topic`.
- Raised output-token budgets across the pre-input planner chain and router layers to reduce false truncation on upstream relays that burn excessive reasoning tokens.
- Added request pacing for pre-input planner calls so relay services with strict per-minute limits are less likely to trip repeated `429` failures.
- Changed city autonomous-action API failures to stop the action and emit a folded error record instead of randomly forcing the character to wander somewhere unrelated.
- Reworked proactive city-to-private-chat prompts so “initiative” favors event-driven updates, current state, and concrete incidents rather than repetitive openers like “what are you doing?”.
- Strengthened time-of-day guidance so daytime replies are less likely to inherit late-night inertia such as repeatedly urging the user to sleep.
- Updated this README to remove stale wording that still described `vectra` as part of the current real-time retrieval architecture.

### Stack

- Frontend: React 19 + Vite
- Backend: Node.js + Express + ws
- Primary storage: SQLite via `better-sqlite3`
- Vector search: Qdrant
- Real-time memory path: Qdrant + SQLite text/metadata

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

Production-style local serving:

```bash
npm --prefix client run build
npm --prefix server run start
```

`npm run dev` starts the Vite dev server plus the backend. If you want the backend to serve the built frontend from `client/dist`, build the client first on that machine.

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
- a JWT secret file when not provided by env

Qdrant behavior:

- Uses Qdrant when reachable
- Creates Qdrant collections lazily on first memory write

SQLite stores full message / memory content and metadata. Qdrant is the active real-time vector retrieval backend.

### 2026-04-05 Fix Notes

Today’s work focused on the Claude private-chat path, the RAG retrieval pipeline, and a few front-end UX regressions:

- Removed chat-time self-healing index rebuilds from the live retrieval path. Previously, a normal private-chat request could enter `retrieve`, decide the index looked unhealthy, and start rebuilding during the reply, which caused long hangs and heavy local CPU usage.
- Disabled vectra in the real-time retrieval path by default. The current live path is effectively `Qdrant + SQLite memory content + lexical/semantic fallback`. Local vectra is now opt-in only via `LOCAL_VECTOR_INDEX_ENABLED=1`.
- Kept the retrieval-query expansion step as part of the design, but removed the parts of the live path that were causing retrieval to stall.
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

### City Module Structure

The `server/plugins/city` plugin is no longer treated as a single giant file. It is now being split into three layers: entry orchestration, persistence, and domain services.

Current layout:

```text
server/plugins/city/
  index.js
  cityDb.js
  services/
    actionService.js
    mayorService.js
    mayorRuntimeService.js
    questService.js
    socialService.js
```

Responsibilities:

- `index.js`
  The DLC/plugin entry.
  It wires dependencies, mounts `/api/city/*` routes, and orchestrates services.

- `cityDb.js`
  The persistence layer for city-specific data.
  It owns `city_*` tables plus CRUD for districts, logs, quests, inventory, announcements, and config.

- `services/actionService.js`
  The city action executor.
  It resolves what happens when a character performs an in-city action: stamina, money, state updates, shopping, food, medical, study, logging, and post-action sync.

- `services/questService.js`
  The quest lifecycle layer.
  It owns claim/progress/report/resolve flow and quest result narration.

- `services/mayorService.js`
  The mayor AI domain layer.
  It handles mayor model selection, JSON parsing, quest difficulty scoring, quest progress scoring, and applying mayor decisions.

- `services/mayorRuntimeService.js`
  The mayor AI runtime/orchestration layer.
  It decides when the mayor should run, prevents duplicate concurrent runs, executes the mayor prompt, and handles fallback generation.

- `services/socialService.js`
  The social encounter layer.
  It detects same-location collisions, enforces cooldowns, simulates multi-character encounters, and applies affinity / impression / outreach results.

Why this split exists:

- `city/index.js` originally mixed routes, scheduling, action execution, mayor logic, quests, social encounters, prompt assembly, and runtime guards in one place.
- That made the file hard to reason about and increased regression risk whenever a new feature touched the city system.
- The current goal is not a one-shot rewrite. It is an incremental extraction of the heaviest business areas so `index.js` becomes an orchestrator instead of the implementation of every feature.

Recommended mental model:

1. `index.js` is the plugin entry and composition root.
2. `cityDb.js` is the persistence boundary.
3. `services/*` hold the actual business logic.
4. New city features should prefer extending an existing service or adding a new service, instead of growing `index.js` again.

Recommended next extraction steps:

- `routes/`
  Move `/api/city/*` handlers out of `index.js`
- `scheduleService`
  Isolate schedule generation and daily plan logic
- Smaller action submodules
  Split shopping / medical / gambling branches out of `actionService` if that file grows too fast

The point of the current structure is not “perfect architecture”.
It is to keep the project shippable while preventing `city/index.js` from becoming a permanent single-file bottleneck.

### License

This project is licensed under **CC BY-NC-ND 4.0**.

That means:

- sharing and redistribution are allowed
- attribution to `NANA3333333 / Nana` and the original repository is required
- commercial use is not allowed
- modified redistribution is not allowed

See [LICENSE](./LICENSE) and the [official Creative Commons page](https://creativecommons.org/licenses/by-nc-nd/4.0/) for details.
