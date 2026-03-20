# ChatPulse

ChatPulse is a full-stack AI social simulation platform that turns LLM-driven characters into persistent digital actors rather than one-turn chatbots. Instead of only replying when prompted, characters maintain memory, react across private chat and group chat, publish to a social feed, and continue living inside an autonomous city simulation while the user is offline.

This project is designed as a product-style system, not just an interface demo. The core engineering challenge is coordinating long-term character state across multiple surfaces while keeping the experience realtime, coherent, and extensible.

## Why This Project Stands Out

- Built a multi-surface AI experience where the same character can participate in private chat, group chat, social feed interactions, and city-life simulation.
- Implemented persistent memory with vector retrieval plus structured SQLite storage so characters can recall prior events, preferences, and relationship shifts.
- Designed a unified context-building pipeline that merges short-term conversation state, long-term memory, emotional state, and city activity into one prompt foundation.
- Added realtime synchronization with WebSockets so the UI can reflect autonomous character activity without manual refreshes.
- Structured the backend around plugin-style modules such as `city`, `groupChat`, `economy`, `relationships`, `theme`, and `scheduler` to support iterative expansion.

## Product Overview

ChatPulse explores a simple question: what happens if AI characters do not disappear after each turn?

In this system, characters can:

- proactively message the user
- remember prior interactions
- build affinity, jealousy, stress, and emotional continuity
- participate in group conversations
- post and react in a social feed
- follow autonomous schedules in a simulated city
- trigger cross-context reactions based on what happened elsewhere in the product

That makes ChatPulse closer to an AI-native social world than a standard chatbot app.

## Core Features

### 1. Persistent Character System

Each character carries ongoing state instead of stateless chat history:

- relationship metrics and emotional drift
- hidden internal state
- physical and city-life status
- memory extraction and retrieval
- cross-session continuity

### 2. Unified Context Engine

The backend uses a shared context builder to construct prompts from:

- recent private chat history
- visible group chat context
- social feed activity
- long-term memory retrieval
- city events and current location
- emotional and physical status

This reduces feature silos and helps characters behave consistently across surfaces.

### 3. Long-Term Memory Pipeline

The memory subsystem combines semantic search and structured persistence:

- local embeddings via `@xenova/transformers`
- vector indexing via `vectra`
- durable storage in SQLite
- memory extraction from recent dialogue
- scheduled daily aggregation and overflow digestion

This allows the system to store both immediate facts and summarized longer-term relationship developments.

### 4. Autonomous City Simulation

Characters do not only chat. They also live in a lightweight simulation layer with:

- districts and locations
- work, eating, sleep, shopping, and encounters
- wallet and energy systems
- event logging
- proactive follow-up messaging after city events

The result is a stronger sense of off-screen life and believable continuity.

### 5. Realtime Full-Stack Experience

The app uses a React frontend and a Node.js backend connected through HTTP plus WebSockets:

- React + Vite client for interactive UI flows
- Express API for auth, chat, uploads, and plugin routes
- WebSocket server for live state updates and proactive messages
- SQLite-backed per-user data persistence

## Technical Architecture

### Frontend

- React 19
- Vite
- modular component structure for chats, groups, feed, settings, and admin workflows

### Backend

- Node.js
- Express
- WebSocket server via `ws`
- plugin-based route and system registration
- JWT auth, rate limiting, upload handling, and local persistence

### Data and AI Infrastructure

- SQLite for core application data
- local vector indices for semantic memory retrieval
- pluggable LLM and memory-model integration
- scheduled/background character activity

## Engineering Highlights

Some of the most resume-relevant engineering decisions in this project:

- Created a shared prompt-orchestration layer that keeps AI behavior consistent across chat, group, social, and simulation contexts.
- Combined symbolic state, structured relational storage, and vector retrieval to support richer character continuity.
- Used plugin-style backend modules to keep complex feature growth manageable.
- Implemented realtime updates over WebSockets for autonomous events and UI refresh.
- Added security and operational basics such as JWT auth, rate limiting, file upload validation, and stack management scripts.

## Project Structure

```text
client/
  src/
    components/
    plugins/
    utils/

server/
  index.js
  db.js
  engine.js
  contextBuilder.js
  memory.js
  emotion.js
  plugins/
    adminDashboard/
    city/
    economy/
    groupChat/
    relationships/
    scheduler/
    theme/

scripts/
  start-stack.ps1
  stop-stack.ps1
  status-stack.ps1
```

## Local Development

### Recommended Startup

From the project root:

```bat
start-stack.cmd
status-stack.cmd
stop-stack.cmd
```

Default local endpoints:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://localhost:8000`

### Manual Startup

Frontend:

```bat
cd client
npm install
npm run dev
```

Backend:

```bat
cd server
npm install
node index.js
```

## Resume-Ready Description

If you want to describe this project on a resume, you can adapt wording like:

> Built a full-stack AI social simulation platform with React, Node.js, WebSockets, SQLite, and vector memory retrieval, enabling persistent LLM characters to maintain memory, emotions, and cross-context behavior across private chat, group chat, social feed, and autonomous city simulation.

Alternative shorter version:

> Developed a realtime AI character platform with long-term memory, prompt orchestration, and simulation-driven interactions using React, Express, SQLite, WebSockets, and local vector search.

## Roadmap

- improve deployment and multi-user hosting workflows
- deepen admin and moderation tooling
- expand observability and memory-debugging capabilities
- make city event authoring more expressive
- continue improving character continuity and cross-context reasoning

## Notes

- Historical one-off tools are archived under `server/_archive_tools`.
- The current codebase already includes admin-oriented and extensible plugin modules for future hosted product workflows.

---

## 中文版

### 项目简介

ChatPulse 是一个全栈 AI 社交模拟平台，目标不是做一个“问一句答一句”的聊天机器人，而是构建一组可以持续存在、持续生活、持续演化的 AI 角色。

在这个系统里，角色不仅能和用户私聊，还能参与群聊、发布和互动“朋友圈”内容，并在一个自治的城市模拟环境中继续生活。即使用户离线，角色的状态、记忆、关系和行为也会继续推进。

这个项目更接近“AI 原生社交产品”的探索，而不是一个简单的 LLM 界面 Demo。

### 项目亮点

- 构建了一个多场景联动的 AI 角色系统，角色可同时存在于私聊、群聊、社交动态和城市模拟中。
- 实现了长期记忆机制，结合向量检索与 SQLite 结构化存储，让角色能够回忆历史事件、偏好和关系变化。
- 设计了统一上下文构建管线，将短期聊天、长期记忆、情绪状态和城市行为整合到同一套 Prompt 基础中。
- 通过 WebSocket 实现实时同步，让前端可以无刷新接收角色主动行为和状态变化。
- 后端采用插件化模块设计，已支持 `city`、`groupChat`、`economy`、`relationships`、`theme`、`scheduler` 等扩展模块，便于后续持续迭代。

### 核心能力

#### 1. 持续存在的 AI 角色

角色并非一次性对话对象，而是具有连续状态的数字人格，包含：

- 关系值与情绪变化
- 隐藏心理状态
- 体力、金钱、位置等生活状态
- 记忆提取与回忆能力
- 跨会话持续性

#### 2. 统一上下文引擎

后端通过共享的上下文构建器，将以下信息统一汇总：

- 最近私聊记录
- 群聊可见上下文
- 社交动态内容
- 长期记忆检索结果
- 城市场景与当前位置
- 情绪与身体状态

这让角色在不同功能入口下依然能保持更一致的行为逻辑和人格连续性。

#### 3. 长期记忆系统

记忆子系统采用“语义检索 + 结构化持久化”的组合方案：

- 使用 `@xenova/transformers` 生成本地嵌入
- 使用 `vectra` 构建本地向量索引
- 使用 SQLite 持久化存储记忆数据
- 从近期对话中提取可保存记忆
- 支持日级聚合与溢出消化

这样既能保留即时事实，也能沉淀长期关系和事件演化。

#### 4. 自治城市模拟

角色不仅会聊天，还会在城市系统中“生活”：

- 具备区域和地点概念
- 支持工作、吃饭、睡觉、购物、遭遇事件等行为
- 拥有钱包、体力等数值系统
- 记录事件日志
- 可在城市事件后主动联系用户

这让角色具备更强的离屏生活感和可信度。

#### 5. 实时全栈交互

系统采用 React 前端与 Node.js 后端协同实现：

- React + Vite 负责聊天、群聊、动态、设置等交互界面
- Express 提供鉴权、聊天、上传和插件路由能力
- WebSocket 用于实时推送状态更新和主动消息
- SQLite 用于用户与角色数据持久化

### 技术架构

#### 前端

- React 19
- Vite
- 模块化组件结构，覆盖聊天、群组、动态、设置与管理能力

#### 后端

- Node.js
- Express
- `ws` WebSocket 服务
- 插件化功能注册机制
- JWT 鉴权、限流、上传校验与本地数据持久化

#### 数据与 AI 基础设施

- SQLite 存储核心业务数据
- 本地向量索引用于语义记忆检索
- 可插拔的 LLM / 记忆模型配置
- 定时任务与后台角色行为调度

### 适合写进简历的描述

你可以在中文简历中这样描述这个项目：

> 独立开发了一个全栈 AI 社交模拟平台，基于 React、Node.js、WebSocket、SQLite 与向量检索实现持续存在的 AI 角色系统，使角色能够在私聊、群聊、社交动态和城市模拟等多场景中保持记忆、情绪与行为连续性。

更简短一点的版本：

> 开发了一个具备长期记忆、统一 Prompt 编排和实时状态同步能力的 AI 角色平台，技术栈包括 React、Express、SQLite、WebSocket 与本地向量检索。

### 项目价值

这个项目的重点不只是“接入大模型”，而是在产品层和工程层解决以下问题：

- 如何让 AI 角色跨场景保持一致性
- 如何让长期记忆真正参与角色行为
- 如何让离线状态下的角色继续推进生活与关系
- 如何用插件化架构承接复杂功能持续扩展

如果作为作品集项目，它比较能体现全栈开发、AI 应用工程、Prompt 编排、状态建模和产品化设计能力。
