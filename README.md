# ChatPulse

ChatPulse 是一个本地优先的 AI 社交模拟应用。它把私聊、群聊、长期记忆、朋友圈、日记、商业街生活模拟、像素街区、经济系统、住房社交、管理后台和实验性联网工具放在同一个本地应用里。

项目目标不是做一个简单聊天壳，而是让角色拥有可持续的上下文、可检索的长期记忆、可变化的状态，以及能和其他角色、地点、任务、金钱、日程发生关系的生活系统。

## 当前功能

### 账号与权限

- 本地账号登录 / 注册。
- root / admin 管理员角色。
- 管理员后台支持用户、邀请码、封禁、改角色、重置密码、强制登出和全局公告。
- JWT 登录态，WebSocket 使用显式认证消息，不把 token 放进 URL。
- 每个用户使用独立业务数据库，认证库和用户数据分离。

### 私聊

- 角色私聊、消息重试、批量删除、清空角色数据。
- 每个角色可配置模型 URL、Key、模型名、人设、头像、横幅、语音、主动消息和上下文窗口。
- 支持 RAG 流程状态展示：切题判断、路由、主题扩展、决策、改写、召回、输出。
- 支持连续相同 API 错误折叠，避免错误消息刷屏。
- 支持消息级 TTS 音频、TTS 预览和腾讯音色列表。
- 支持私聊转账、钱包、角色间好感 / 印象相关扩展。
- 生成链失败时保持失败可见，不伪造成功回复。

### 角色与关系

- 创建、编辑、删除角色。
- AI 生成角色基础配置。
- 角色状态包含心情、压力、饥饿、体力、睡眠债、金币、位置等。
- 关系 DLC 支持好友推荐、角色关系、互相印象和印象历史。
- 角色可触发朋友圈、日记、关系、情绪、商业街意图等结构化标签。

### 长期记忆

- 实时主路径：SQLite 保存正文和元数据，Qdrant 负责语义向量检索。
- 支持手动查看角色记忆、删除、导入、导出和立即提取。
- 支持新版记忆库视图、旧库备份视图、正式记忆 / 来源卡片分类。
- 支持记忆维护：批量整理、时间绑定、补全、外部记忆导入预览、自动运行、提交。
- 支持 Qdrant 迁移脚本和系统嵌入状态检查。
- 本地 `vectra` 只作为显式开启的兼容路径；当前实时链路优先使用 Qdrant。

### 朋友圈与日记

- 角色朋友圈动态、图片、点赞、评论。
- 用户个人资料、头像、横幅、简介、朋友圈参数。
- 角色秘密日记，支持密码解锁和删除。
- 朋友圈、日记、私聊会进入后续上下文或长期记忆整理流程。

### 群聊

- 创建群聊、编辑群聊、增删成员、删除群聊。
- 群聊消息、群聊 AI 回复、历史读取、批量删除。
- 群聊支持暂停 AI、无链模式和主动消息计时。
- 群红包和领取记录由经济 DLC 提供。

### 经济系统

- 用户与角色钱包。
- 私聊转账卡片、领取、退款。
- 群红包创建、领取、查看。
- 商业街金币、物品、库存、消费、任务奖励与钱包同步。

### 商业街

商业街是项目里的生活模拟系统，覆盖角色状态、地点、行动、任务、社交和市长 AI。

- 商业街角色列表、地点 / 区域、商品、库存、公告、事件、任务。
- 管理操作：给金币、喂食、给物品、时间跳跃、清理日志、清空商业街数据。
- 角色日程生成、自动行动、行动日志、行动重掷。
- 状态系统：饱腹、体力、压力、心情、睡眠债、胃负担、医院恢复等。
- 行动系统：工作、购物、进食、医疗、学习、赌博、休息、地点活动等。
- 公告任务：领取、推进、汇报、完成、奖励、失败处理。
- 市长 AI：生成事件 / 任务 / 广播、评分任务难度、调整商品价格。
- 社交遭遇：同地点角色碰撞、多人发言、关系变化、印象更新。
- 商业街可触发私聊反馈，但生成失败不会写入伪造成功。
- 默认安全模式会降低后台自动行为强度，避免开发环境被后台任务拖慢。

### 像素世界

像素世界是商业街的可视化和行为树实验面板。

- 可视化街区编辑：建筑、道路、装饰、天空、街段、层级、画布缩放。
- 双角色像素人物控制、自动移动、地点锚点、路径与碰撞规则。
- 支持预览模式、保存布局、复制 JSON、查看地点锚点和图层。
- 行为树面板支持完整树、输入、patch、输出调试。
- 基础枝丫用于角色无互动时的自动生活行为。
- 特殊枝丫用于玩家靠近角色后继续互动。
- 后续枝丫会带上当前行为树和最近特殊互动上下文。
- 特殊互动新增防重复：如果模型生成内容疑似复读上一轮，会返回可重试错误，而不是本地改写成成功。

### 住房与社交

- 住房职业 / 阶层、房源、角色绑定、租金支付。
- 中介系统和房源广告。
- 住房社交面板用于管理角色住处和社会身份。

### 成长课程

- 城市成长 DLC 提供课程管理。
- 可配置课程、价格、持续时间、恢复 / 消耗等字段。
- 角色可通过商业街行动或课程系统参与成长相关内容。

### MCP 实验台

- 实验性联网工具层。
- 支持搜索、抓取 URL、任务队列、任务重跑、删除任务。
- 支持知识条目保存与检索。
- 支持搜索源配置：auto、DuckDuckGo、Serper、Tavily、Brave、Bing 等。
- 当前定位是实验台，不是默认自动工具调用层。

### 主题与外观

- 全局主题设置和 CSS 变量。
- AI 主题生成。
- 头像、背景、侧边栏颜色、主色等 UI 配置。
- 私聊抽屉、记忆库、后台任务、商业街和像素世界都有独立 UI 面板。

### 备份与恢复

- 系统备份导出为 zip。
- 支持导入 zip 或数据库文件。
- 支持系统擦除。
- 角色包导入 / 导出包含聊天、记忆、朋友圈、日记及可重建 Qdrant 索引的数据。
- 导入路径做了路径穿越防护。

## 机制约定

这些约定是产品机制，不是待修 bug：

- AI / RAG / 行为树 / JSON 解析失败时，应该返回错误让用户重试。
- 不用默认回复、默认记忆、默认行为树 patch 去伪造成功。
- 商业街行动、社交遭遇、任务结算、市长 AI 等生成链路失败时，优先停止本轮写入。
- 输入校验、数值边界、权限检查、数据一致性属于必须修复的范围。

## 技术栈

- 前端：React 19、Vite、lucide-react
- 后端：Node.js、Express 5、ws
- 主数据库：SQLite / better-sqlite3
- 向量检索：Qdrant
- 本地嵌入：`@xenova/transformers`、ONNX Runtime
- 上传与媒体：multer、sharp
- 备份：archiver、unzipper
- 定时任务：node-cron

## 本地运行

### 环境要求

- Node.js 18+，推荐使用项目 `.runtime/node20` 或 Node 20。
- npm 9+。
- 可选：Docker Desktop，用于本地运行 Qdrant。

### 安装

```bash
git clone https://github.com/NANA3333333/ChatPluse.git
cd ChatPluse
npm run setup
```

`npm run setup` 会安装根目录、`server`、`client` 依赖，并创建本地运行目录。

Windows 可以直接运行：

```bat
install-and-start.cmd
```

macOS / Linux 可以运行：

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

### 启动开发环境

```bash
npm run dev
```

启动后访问：

- 前端开发服务：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端服务和构建后前端：[http://localhost:8000](http://localhost:8000)
- Qdrant 默认地址：[http://127.0.0.1:6333](http://127.0.0.1:6333)

`npm run dev` 会优先使用 `.runtime/node20` 启动后端和 Vite，避免 Windows 上 `better-sqlite3` 因 Node ABI 不一致而加载失败。如果没有 bundled Node，会退回当前系统 Node。

### 构建前端

```bash
npm --prefix client run build
```

后端会从 `client/dist` 提供构建后的前端页面。如果你主要使用 `http://localhost:8000`，改完前端后需要重新 build。

### 启动 Qdrant

```bash
docker compose up -d
```

迁移已有记忆到 Qdrant：

```bash
npm run migrate:qdrant
```

常用参数：

```bash
npm run migrate:qdrant -- --dry-run
npm run migrate:qdrant -- --user <userId>
npm run migrate:qdrant -- --character <characterId>
```

### 健康检查

```bash
npm run doctor
```

它会检查依赖、目录、SQLite native module 和 Qdrant 连接状态。

## 常用命令

```bash
npm run setup
npm run dev
npm run doctor
npm run migrate:qdrant
npm run cleanup:city-memories
npm --prefix client run lint
npm --prefix client run build
npm --prefix server test
```

Windows 辅助脚本：

```bat
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

## 配置

主要配置文件在 `server/.env`。常用项包括：

- `ADMIN_PASSWORD`：全新认证库初始化时使用的管理员密码；不设置时会生成一次性随机密码并打印在后端控制台。
- `JWT_SECRET`：固定 JWT secret；不设置时会生成到本地数据目录。
- `PORT`：后端端口，默认 `8000`。
- `QDRANT_ENABLED`：是否启用 Qdrant，默认启用。
- `QDRANT_URL`：Qdrant 地址，默认 `http://127.0.0.1:6333`。
- `QDRANT_API_KEY`：远程 Qdrant 需要鉴权时填写。
- `LOCAL_VECTOR_INDEX_ENABLED=1`：显式启用旧本地 vectra 路径。
- `CP_SAFE_MODE`：商业街后台安全模式；默认开启较保守的后台行为。
- `SERPER_API_KEY` / `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY`：MCP Lab 搜索源可选 Key。

不要把真实模型 Key、管理员密码或生产数据库提交到仓库。

## 数据与目录

运行时会自动创建：

```text
data/
  master.db
  chatpulse_user_<id>.db
  qdrant/
  .jwt_secret

server/public/uploads/
client/dist/
.runtime/
```

核心源码结构：

```text
client/
  src/
    App.jsx
    components/
    plugins/
    utils/

server/
  index.js
  db.js
  authDb.js
  engine.js
  memory.js
  qdrant.js
  plugins/

scripts/
  setup-local.js
  doctor.js
  dev.js
  migrate-memories-to-qdrant.js
```

## 插件结构

后端插件位于 `server/plugins/`：

```text
adminDashboard/
backup/
city/
cityGrowth/
economy/
groupChat/
mcpLab/
relationships/
scheduler/
socialHousing/
theme/
```

前端插件入口在 `client/src/plugins.js`，当前可见插件包括：

- MCP 实验台
- 管理员后台
- 住房与社交
- 像素实装
- 商业街

## City 模块结构

商业街模块已经从单文件巨块逐步拆为入口、路由、数据层和 service 层：

```text
server/plugins/city/
  index.js
  cityDb.js
  routes/
    coreRoutes.js
    eventQuestRoutes.js
  services/
    actionService.js
    adminGrantService.js
    mayorService.js
    mayorRuntimeService.js
    questService.js
    socialService.js
  utils/
```

职责大致如下：

- `index.js`：插件入口、依赖装配、后台调度和仍未完全拆出的 city 路由。
- `routes/*`：核心管理路由、事件和任务路由。
- `cityDb.js`：city 表结构和持久化接口。
- `actionService.js`：角色商业街行动执行。
- `adminGrantService.js`：管理员赠与后的私聊反馈流程。
- `questService.js`：公告任务推进和结算。
- `mayorService.js`：市长 AI 领域逻辑。
- `mayorRuntimeService.js`：市长自动运行编排。
- `socialService.js`：同地点社交遭遇。
- `utils/*`：输入校验和共享工具。

新 city 功能优先放入合适的 service / route / utils 文件，不建议继续把大量业务塞回 `index.js`。

## 测试与质量检查

当前项目主要用 smoke test 保护关键行为和安全边界：

```bash
npm --prefix server test
```

常用前端检查：

```bash
npm --prefix client run lint
npm --prefix client run build
```

重要检查覆盖：

- 鉴权和权限边界。
- 上传、备份、导入路径安全。
- 角色、消息、记忆、群聊、经济、商业街输入校验。
- AI / RAG / 行为树失败不能伪造成成功。
- 商业街数值边界和 DB 防御。
- 像素世界行为树选择、失败可见性、防重复。
- 聊天抽屉懒加载不能让中间区域白屏。

## 许可证

本项目采用 **CC BY-NC-ND 4.0** 许可。

这意味着：

- 可以转载和分享。
- 必须注明作者 `NANA3333333 / Nana` 以及原始仓库链接。
- 禁止商用。
- 禁止修改后再发布。

完整许可见 [LICENSE](./LICENSE) 和 [Creative Commons 官方页面](https://creativecommons.org/licenses/by-nc-nd/4.0/)。
