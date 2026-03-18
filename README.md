# ChatPulse

**English** | **中文**

ChatPulse is an AI social simulation app built around private chats, group chats, a social feed, and an autonomous city-life system.

ChatPulse 是一个以私聊、群聊、朋友圈和“商业街”自治生活模拟为核心的 AI 社交模拟应用。

Instead of behaving like a single-turn chatbot demo, characters in ChatPulse are designed to persist over time: they keep memories, build relationships, react emotionally, post updates, join group chats, and continue living inside the city simulation even when the user is offline.

它不是一个单轮问答式的聊天 Demo。ChatPulse 里的角色会持续生活：他们会积累记忆、建立关系、产生嫉妒和焦虑、发朋友圈、参与群聊，并在用户不在线时继续在商业街系统里行动。

## Highlights | 核心亮点

- Persistent AI characters  
  持续存在的 AI 角色
  - Private chat, group chat, moments, diaries, hidden thoughts, gifts, transfers  
    私聊、群聊、朋友圈、日记、隐藏心态、礼物、转账

- Unified context pipeline  
  统一上下文管线
  - Private chat, visible group messages, moments, city logs, long-term memory, pressure, jealousy, and hidden state are merged into one shared context builder  
    私聊、群聊可见内容、朋友圈、商业街日志、长期记忆、压力、嫉妒、隐藏状态会汇入同一套大输入库

- Long-term memory system  
  长期记忆系统
  - Vector retrieval  
    向量检索
  - Overflow digestion via `W`  
    通过 `W` 做滑窗溢出消化
  - Daily memory aggregation  
    每日记忆汇总
  - Batch-based daily aggregation for smaller memory models  
    支持给小模型分批读取、分批整理，避免上下文过长

- Commercial Street simulation  
  商业街自治模拟
  - Districts, items, schedules, city logs, encounters, autonomous actions  
    分区、商品、日程、活动日志、偶遇、自治行动
  - Characters can proactively message the user after city events  
    角色可以在商业街经历事件后主动联系用户
  - Ignored outreach can escalate anxiety and jealousy  
    连续被晾着后会逐步累积焦虑与嫉妒

- Social-emotional systems  
  社交情绪系统
  - Pressure  
    压力
  - Jealousy  
    嫉妒
  - Cross-context awareness between private chat, group chat, moments, and city life  
    私聊、群聊、朋友圈、商业街之间的交叉感知

- Admin-ready architecture  
  可扩展的管理端架构
  - The admin dashboard remains in the active codebase and can be extended for hosted account and permission management  
    管理员后台仍保留在主链中，后续可继续扩展为云端账号与权限管理

## Core Modules | 核心模块

### 1. Private Chat | 私聊

Characters can:

角色可以：
- proactively message the user  
  主动私聊用户
- retrieve relevant long-term memories  
  检索相关长期记忆
- react emotionally to neglect or triangulation  
  对冷落、偏爱他人、忽视产生情绪反应
- maintain hidden state and emotional continuity  
  保持隐藏心态和连续情绪

### 2. Group Chat | 群聊

Characters can:

角色可以：
- talk to each other in groups  
  在群里彼此对话
- read their own visible private-chat window when replying in group  
  在群聊时读取自己私聊窗口中可见的内容
- bring group experiences back into private chat  
  把群聊经历带回私聊里继续影响反应

### 3. Moments Feed | 朋友圈

Characters can:

角色可以：
- post moments  
  发布朋友圈
- like and comment  
  点赞和评论
- use moments as part of the shared contextual world  
  把朋友圈内容纳入统一上下文

### 4. Commercial Street | 商业街

The city simulation includes:

商业街系统包含：
- district management  
  分区管理
- item management  
  商品管理
- autonomous schedules  
  自主日程
- work, meals, shopping, leisure, treatment, gambling, and special services  
  打工、吃饭、购物、休闲、治疗、赌博和特殊服务
- encounter resolution between characters in the same location  
  同地点角色之间的偶遇与社交结算

### 5. Memory System | 记忆系统

Memory currently has three main paths:

当前记忆主要有三条路径：
- immediate extraction  
  即时提取
- overflow digestion (`W`)  
  溢出消化（`W`）
- scheduled daily aggregation  
  定时的每日记忆汇总

Daily aggregation now supports chunked processing:

每日记忆汇总现已支持分批处理：
- collect private chats, group chats, moments, and city activities from the day  
  汇总当天私聊、群聊、朋友圈、商业街活动
- merge them into one timeline  
  合并成统一时间线
- split them into configurable batches  
  按可配置的批次大小切分
- call the memory model repeatedly until the full day is processed  
  多次调用记忆小模型，直到整天内容都被整理完

## Tech Stack | 技术栈

- Frontend: React + Vite  
  前端：React + Vite
- Backend: Node.js + Express  
  后端：Node.js + Express
- Database: SQLite  
  数据库：SQLite
- Memory retrieval: local vector index + SQLite  
  记忆检索：本地向量索引 + SQLite
- Realtime sync: WebSocket-based state refresh  
  实时同步：基于 WebSocket 的状态刷新

## Project Structure | 项目结构

```text
client/
  src/
    components/
    plugins/city/

server/
  index.js
  db.js
  engine.js
  contextBuilder.js
  memory.js
  plugins/
    groupChat/
    city/
    scheduler/

scripts/
start-stack.cmd
stop-stack.cmd
status-stack.cmd
```

## Local Development | 本地运行

### Recommended | 推荐方式

Use the stack scripts from the project root:

推荐直接使用根目录的启动脚本：

```bat
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

Default ports | 默认端口：
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8000`

### Manual Start | 手动启动

Frontend | 前端

```bat
cd client
npm install
npm run dev
```

Backend | 后端

```bat
cd server
npm install
node index.js
```

## Direction | 项目方向

This project is not trying to be a generic chatbot interface.

这个项目的目标不是做一个泛化聊天壳。

The current direction is:

当前重点方向是：
- stronger character continuity  
  更强的角色连续性
- stronger emotional persistence  
  更明显的情绪持续性
- richer cross-surface awareness between private chat, group chat, moments, and city actions  
  更强的私聊、群聊、朋友圈、商业街联动
- believable off-screen life simulation  
  更可信的离线生活模拟
- future hosted account management through the admin system  
  后续通过管理员系统支持云端账号管理

## Notes | 备注

- Historical tools and one-off scripts were archived under  
  历史工具脚本和一次性脚本已归档到：
  - [server/_archive_tools](server/_archive_tools)

- The admin dashboard remains part of the active codebase  
  管理员后台仍保留在主链代码中：
  - [client/src/components/AdminDashboard.jsx](client/src/components/AdminDashboard.jsx)

## Roadmap | 路线图

- hosted deployment flow for multiple user accounts  
  面向多用户的云端部署流程
- stronger admin workflows  
  更完整的管理员工作流
- account and permission management  
  账号与权限管理
- better memory inspection and debugging tools  
  更好的记忆查看与调试工具
- more expressive city event authoring  
  更强的商业街事件编辑能力
