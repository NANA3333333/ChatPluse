

# ChatPulse 中文说明

ChatPulse 是一个本地优先的 AI 社交模拟应用，前端使用 React，后端使用 Express，主存储是 SQLite，并支持接入 Qdrant 做向量记忆检索。

## 技术栈

- 前端：React 19 + Vite
- 后端：Node.js + Express + ws
- 主存储：SQLite（`better-sqlite3`）
- 向量检索：Qdrant
- 本地兜底向量索引：vectra + `@xenova/transformers`

## 本地部署

### 环境要求

- Node.js 18 或更高版本
- npm 9 或更高版本
- 可选：Docker Desktop（如果你想在本地跑 Qdrant）

### 1. 克隆仓库

```bash
git clone https://github.com/NANA3333333/ChatPluse.git
cd ChatPulse
```

### 2. 初始化工作区

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

`npm run setup` 会自动完成：

- 安装根目录、`server`、`client` 的依赖
- 创建本地运行目录
- 在不存在时自动生成 `server/.env`
- 创建仓库中不提交的本地目录

### 3. 配置环境变量

检查并按需修改 `server/.env`。

常用配置：

- `ADMIN_PASSWORD`：推荐设置，便于固定首次登录密码
- `QDRANT_ENABLED`：默认建议保持 `1`
- `QDRANT_URL`：默认是 `http://127.0.0.1:6333`

### 4. 启动项目

跨平台方式：

```bash
npm run dev
```

Windows 脚本：

```bat
install-and-start.cmd
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

macOS / Linux 脚本：

```bash
chmod +x install-and-start.sh
./install-and-start.sh
```

启动后访问：

- 前端：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端：[http://localhost:8000](http://localhost:8000)

### 5. 首次登录

全新认证库下，系统会自动创建 root 账号：

- 用户名：`Nana`
- 默认密码：`12345`

如果你在 `server/.env` 中设置了 `ADMIN_PASSWORD`，那么全新初始化时会使用你设置的密码，而不是 `12345`。

## 数据库、缓存与向量库初始化

新克隆的仓库不需要自带任何运行时数据。

首次启动时会自动创建：

- `data/master.db`：认证库
- `data/chatpulse_user_<id>.db`：每个用户自己的业务数据库
- `server/public/uploads/`：上传目录
- `data/vectors/...`：本地 vectra 索引目录
- JWT secret 文件（如果环境变量未提供）

Qdrant 的行为：

- 如果 Qdrant 可用，系统优先使用 Qdrant
- 实时私聊/群聊 RAG 现在默认不再依赖本地 vectra 作为自动回退
- Qdrant collection 会在首次写入记忆时按需自动创建

也就是说，项目仍然可以在本地跑起来，但实时记忆检索现在建议保持 Qdrant 可用。

## 2026-04-05 修复记录

今天这一轮主要修的是 Claude 私聊链、RAG 检索链和几个前端体验问题：

- 修掉了聊天链里“边聊天边自愈重建索引”的设计。之前这会导致 `retrieve` 卡死、风扇狂转、RAG 长时间停在“召回”阶段。现在实时聊天只负责查，不再在对话现场修索引。
- 关闭了实时链中的 vectra 参与。当前默认只走 `Qdrant + SQLite 正文 + lexical/semantic fallback`，不再让老的本地 vectra 索引和 Qdrant 打架。只有显式设置 `LOCAL_VECTOR_INDEX_ENABLED=1` 才会重新启用。
- 关闭了“检索前再次调用小模型扩写 query”的默认行为。只有显式设置 `MEMORY_QUERY_EXPANSION_ENABLED=1` 才会开启，避免中转站或额外小模型把 RAG 前置链拖慢。
- 给 RAG 检索补了更细的调试日志，能看到 `retrieve`、每个 slot 的开始/结束、Qdrant 查询、fallback 查询等阶段，方便以后定位“卡在 topics / rewrite / retrieve / output 的哪一步”。
- 新增了 `GET /api/system/embedding-status` 调试接口，用来观察本地 `bge-m3` embedding 层是否真的在工作、是否报错、最近一次耗时如何。
- 放松了 `profile` 槽的过滤规则。以前像“占有欲、撒娇习惯、互动风格、边界感”这种明明属于用户画像的记忆，会因为带一点关系味被全刷掉；现在这类轻度关系化的用户画像可以正常进入 RAG。
- 商业街管理员发钱、补体力、送物品，现在会按正常私聊链触发角色反馈，并像普通聊天一样进入后续上下文；赠送事件文案也统一成“用户名给角色送了什么”。
- 私聊/群聊 emoji 面板补了更多常用表情，并修掉了之前因编码问题变成 `??` 的显示错误。
- 连续相同的系统 API 报错现在会在私聊里合并成一条显示，并标注“连续出现 N 次”，避免同一类 503/500 报错刷屏。

补充说明：

- 当前看到的 Claude `503 model_not_found / no available channel` 更像是中转站线路问题，不是本地 RAG 卡死。
- SQLite 里存的是记忆正文，Qdrant 存的是向量索引；今天暴露的问题不是“记忆内容丢了”，而是“索引状态检查 + 聊天现场自愈”这套设计会把实时对话拖死。

## 可选：启动 Qdrant

如果你想在本地使用 Qdrant：

```bash
docker compose up -d
```

如果你已经有 SQLite / vectra 里的历史记忆，想把它们迁移到 Qdrant：

```bash
npm run migrate:qdrant
```

常用参数：

```bash
npm run migrate:qdrant -- --dry-run
npm run migrate:qdrant -- --user <userId>
npm run migrate:qdrant -- --character <characterId>
```

## 健康检查

运行：

```bash
npm run doctor
```

会检查：

- Node 版本
- 依赖是否安装完整
- 本地运行目录是否存在
- `server/.env` 是否存在
- Qdrant 是否可达

## 常用命令

```bash
npm run setup
npm run dev
npm run doctor
npm run migrate:qdrant
npm run cleanup:city-memories
```

## 项目结构

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

## 给贡献者的说明

- 运行时数据默认不会提交到 Git
- 新 clone 的仓库应视为空状态，本地初始化即可
- 后端启动时会自动加载 `server/.env`

## 许可证

本项目采用 **CC BY-NC-ND 4.0** 许可。

这意味着：

- 允许转载和分享
- 必须注明作者 `NANA3333333 / Nana` 以及原始仓库链接
- 禁止商用
- 禁止修改后再发布

完整许可说明见 [LICENSE](./LICENSE) 和 [Creative Commons 官方页面](https://creativecommons.org/licenses/by-nc-nd/4.0/)。
