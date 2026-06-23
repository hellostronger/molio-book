# 第 2 章 仓库概览与技术栈

> 本章将带你从目录结构开始，逐层理解 Molio 的 pnpm monorepo 架构。我们将识别每个子包的职责边界、关键依赖关系，以及它们如何协作构成完整系统。

## 2.1 Monorepo 结构

Molio 使用 pnpm workspace 管理四个子包：

```
Molio/
├── packages/
│   └── contracts/       @molio/contracts  — 共享类型定义 (纯 TypeScript 类型)
├── apps/
│   ├── daemon/          @molio/daemon     — Hono HTTP 服务端 (API + SSE)
│   ├── web/             @molio/web        — Vite + React 前端
│   └── desktop/         @molio/desktop    — Electron 桌面壳
├── package.json         monorepo 根配置
├── pnpm-workspace.yaml  workspace 定义
└── tsconfig.base.json   共享 TypeScript 配置
```

**依赖关系图：**

```
                    @molio/contracts
                   /       |        \
                  /        |         \
    @molio/daemon   @molio/web   @molio/desktop
         ↑                ↑             |
         |                |             |
         +----------------+-------------+
                (desktop 内嵌 daemon + web)
```

`contracts` 是纯类型包，被所有子包依赖。`daemon` 和 `web` 可以独立运行（开发模式），也可以被 `desktop` 打包在一起（生产模式）。

## 2.2 技术栈全景

| 层级 | 技术 | 版本 | 职责 |
|------|------|------|------|
| **共享类型** | TypeScript | 5.8 | AgentEvent, RunInfo, API types |
| **后端** | Hono + @hono/node-server | latest | HTTP API + SSE |
| **数据库** | better-sqlite3 | latest | SQLite WAL 模式 |
| **前端** | React 19 + Vite 6 | latest | SPA 前端 |
| **桌面** | Electron 40 | latest | 桌面应用壳 |
| **构建** | pnpm workspace | 11.5 | Monorepo 管理 |
| **测试** | node:test + Playwright | - | 单元/E2E 测试 |
| **渲染** | doocs/md (marked v18) | vendored | Markdown 排版 |
| **图谱** | Sigma.js v3 + Graphology | latest | WebGL 知识图谱 |

## 2.3 @molio/contracts — 共享类型

```
packages/contracts/src/
├── index.ts        统一导出入口
├── agent.ts        RuntimeAgentDef, AgentInfo, InstallConfig
├── event.ts        AgentEvent (联合类型), StreamHandler, UsageInfo
├── run.ts          RunStatus, RunInfo
├── api.ts          REST API 请求/响应类型
├── knowledge.ts    Vault, TreeNode, FileContent, Wiki 类型, Graph 类型
└── sse.ts          SSEEnvelope
```

**设计原则**：contracts 包只包含 TypeScript 类型定义，不包含任何运行时代码。这确保了：
- 零构建产物体积
- 无循环依赖风险
- 前后端类型一致性

核心的 `AgentEvent` 联合类型定义了所有可能的事件：

```typescript
// packages/contracts/src/event.ts
export type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string; raw?: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'raw'; line: string };
```

## 2.4 @molio/daemon — 后端服务

```
apps/daemon/src/
├── index.ts              入口：端口检测 + 服务启动
├── server.ts             Hono app 定义 + 路由挂载
├── sse.ts                SSE 传输层
├── core/
│   ├── RunManager.ts     核心：Agent 进程生命周期管理
│   ├── config.ts         配置管理 (~/.molio/config.json)
│   ├── db.ts             SQLite 数据库 (WAL + 迁移)
│   ├── knowledge.ts      知识库文件系统操作
│   ├── transcript.ts     多轮对话 transcript 构建
│   ├── wiki-prompts.ts   Wiki 系统提示词模板
│   ├── turn-text-collector.ts  文本累积器
│   ├── runtimes/         Agent 运行时定义
│   │   ├── registry.ts   注册表
│   │   ├── claude.ts     Claude Code
│   │   ├── codex.ts      OpenAI Codex
│   │   ├── gemini.ts     Gemini CLI
│   │   ├── qwen.ts       Qwen Code
│   │   ├── launch.ts     二进制探测
│   │   ├── env.ts        环境变量构建
│   │   └── install.ts    一键安装引擎
│   ├── streams/          流解析器
│   │   ├── claude-stream.ts    Claude stream-json 解析
│   │   ├── codex-stream.ts     Codex 流解析
│   │   ├── json-event-stream.ts 通用 JSON 事件流
│   │   └── jsonl-parser.ts     JSONL 行解析器
│   ├── conversations/
│   │   └── service.ts    统一会话服务
│   └── weixin/           微信集成
│       ├── service.ts    微信服务编排
│       ├── client.ts     微信 API 客户端
│       ├── message.ts    消息解析
│       ├── media.ts      附件下载
│       └── types.ts      微信类型
├── routes/               HTTP API 路由
│   ├── agents.ts         GET /api/agents
│   ├── runs.ts           POST/GET /api/runs
│   ├── events.ts         GET /api/runs/:id/events (SSE)
│   ├── tool-result.ts    POST /api/runs/:id/tool-result
│   ├── config.ts         GET/PUT /api/config
│   ├── conversations.ts  CRUD /api/conversations
│   ├── projects.ts       CRUD /api/projects
│   ├── knowledge.ts      CRUD /api/knowledge
│   ├── publish.ts        POST /api/publish
│   ├── graph.ts          GET /api/graph
│   ├── proxy.ts          代理路由
│   └── weixin.ts         POST /api/weixin
└── publish-bridge/
    └── bridge-page.ts    发布桥接页面
```

## 2.5 @molio/web — 前端应用

```
apps/web/src/
├── main.tsx              React 入口
├── App.tsx               根组件：路由 + Agent 选择
├── api/
│   ├── client.ts         HTTP 客户端 (fetch wrapper)
│   └── sse.ts            SSE 订阅 (EventSource)
├── hooks/
│   ├── useChat.ts        聊天状态管理 (DB + SSE + 会话)
│   ├── useChatCore.ts    聊天核心逻辑 (消息/流式/工具)
│   ├── useAgents.ts      Agent 列表
│   ├── useKnowledge.ts   知识库状态
│   ├── useProjects.ts    项目管理
│   └── useRuntimes.ts    运行时管理
├── components/
│   ├── HomePage.tsx      主页：聊天界面
│   ├── NavRail.tsx       左侧导航栏
│   ├── ChatPane.tsx      消息列表
│   ├── ChatComposer.tsx  输入框
│   ├── AssistantMessage.tsx  助手消息 (思考 + 工具)
│   ├── kb/               知识库组件
│   ├── graph/            知识图谱 (Sigma.js)
│   └── settings/         设置页面
├── stores/               全局状态 (zustand)
├── i18n/                 国际化
└── vendor/doocs-md/      doocs/md 渲染引擎 (vendored)
```

## 2.6 @molio/desktop — 桌面应用

```
apps/desktop/src/
├── main.js         Electron 主进程
├── preload.cjs     预加载脚本 (contextBridge)
├── updater.js      自动更新 (electron-updater)
├── retry.js        重试退避策略
├── logger.js       文件日志
└── splash.html     启动画面
```

## 2.7 关键设计决策

### 为什么选择 Hono 而非 Express？

Hono 是一个超轻量的 Web 框架，原生支持 `ReadableStream`，这使得 SSE 实现非常自然。对比：

| 特性 | Hono | Express |
|------|------|---------|
| 体积 | ~14KB | ~200KB |
| ReadableStream | 原生支持 | 需要 stream 模块 |
| TypeScript | 一等公民 | 需要 @types |
| ESM 支持 | 原生 | 需要额外配置 |

### 为什么使用 better-sqlite3 而非 ORM？

Molio 的数据模型简单且固定（projects、conversations、messages、vaults），不需要 ORM 的抽象开销。`better-sqlite3` 提供了同步 API，避免了异步查询的复杂性：

```typescript
// 同步 API 在单线程 daemon 中是优势
const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
// 而非: const row = await db.query('SELECT ...')
```

### 为什么 WebUI First？

Electron 只是一个壳，所有业务逻辑都在 Web 层。这意味着：
- E2E 测试直接在浏览器中运行，不需要 Electron 环境
- Web 版可以独立部署（daemon + web 分离）
- 前端开发者不需要理解 Electron 概念

## 小结

- **pnpm monorepo** 将四个子包组织在一起，通过 `@molio/contracts` 共享类型
- **daemon** 是核心后端，负责 Agent 编排、SSE 推送、数据持久化
- **web** 是纯 React 前端，消费 daemon 的 SSE 事件流
- **desktop** 是 Electron 壳，负责启动 daemon + 提供原生能力
- **Hono + better-sqlite3** 的选择体现了轻量、同步、类型安全的设计哲学
