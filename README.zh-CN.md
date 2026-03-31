<p align="center">
  <img src="chatpulse_logo.png" width="120" />
</p>

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
git clone https://github.com/NANA3333333/no.git
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
- 如果 Qdrant 不可用，系统会自动回退到本地 vectra
- Qdrant collection 会在首次写入记忆时按需自动创建

也就是说，即使没有启动 Qdrant，新人依然可以把项目在本地跑起来。

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

## License

ISC
