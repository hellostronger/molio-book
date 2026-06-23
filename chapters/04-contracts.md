# 第 4 章 类型契约：contracts 的统一语言

> `@molio/contracts` 是整个 Molio 的类型中枢。本章将拆解它的六个模块，展示纯类型包如何在零运行时代价的前提下，成为 daemon、web、desktop 三个运行时共享的"统一语言"。读完本章后，你将掌握 Molio 中所有核心数据结构的语义与流转方式。

## 4.1 为什么需要一个 contracts 包？

在多包 monorepo 中，类型共享有三种常见方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| **前端引用后端的内部类型** | 简单 | 反向依赖、破坏分层 |
| **每个包各自定义** | 解耦 | 类型漂移、重复 |
| **共享 contracts 包** | 单一真相来源、无运行时开销 | 需要发布流程 |

Molio 选择了第三种。`packages/contracts/src/` 下只有 `.ts` 类型文件，编译后几乎为空——它不增加任何 bundle 体积，却保证了 daemon 输出的 `AgentEvent` 和 web 前端消费的 `AgentEvent` 结构严格一致。

## 4.2 模块结构

```
packages/contracts/src/
├── index.ts          统一导出（barrel file）
├── agent.ts          RuntimeAgentDef, AgentInfo, InstallConfig
├── event.ts          AgentEvent (联合类型), StreamHandler
├── run.ts            RunStatus, RunInfo
├── api.ts            REST 请求/响应 + ChatMessage + ToolEvent
├── knowledge.ts      Vault, TreeNode, Wiki 操作, Graph
└── sse.ts            SSEEnvelope
```

每个文件职责清晰：**agent 描述运行时是什么**、**event 描述运行时发生什么**、**run 描述运行状态**、**api 描述前后端协议**、**knowledge 描述知识库数据**、**sse 描述传输信封**。

## 4.3 AgentEvent：事件驱动的统一语言

`AgentEvent` 是整个系统的事件协议。它是 TypeScript 的可辨识联合类型（discriminated union），`type` 字段是判别式：

```typescript
// packages/contracts/src/event.ts
export type AgentEvent =
  | { type: 'status';        label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta';    delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use';      id: string; name: string; input: unknown }
  | { type: 'tool_result';   toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage';         usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error';         message: string; raw?: string }
  | { type: 'turn_end';      stopReason: string }
  | { type: 'raw';           line: string };
```

**设计洞察**：

1. **粒度选择**：事件不是"完整响应"，而是增量事件（`text_delta`、`thinking_delta`）。这让前端能逐字符渲染流式输出。
2. **工具调用显式化**：`tool_use` 和 `tool_result` 是独立事件，而不是混在文本里。这让 UI 能渲染出工具卡片。
3. **`raw` 作为逃生舱**：当 stream 解析器遇到无法识别的格式时，回退为 `raw` 事件，保证信息不丢失。
4. **turn_end 的 stopReason**：区分 `end_turn`（自然结束）和 `tool_use`（等待工具结果），前端据此决定是否保持输入框禁用。

## 4.4 RuntimeAgentDef：运行时的身份证

每个 AI 运行时（Claude Code / Codex / Gemini / Qwen）都实现一个 `RuntimeAgentDef` 对象：

```typescript
// packages/contracts/src/agent.ts (简化)
interface RuntimeAgentDef {
  id: string;                    // 'claude' | 'codex' | 'gemini' | 'qwen'
  name: string;                  // 显示名称
  bin: string;                   // CLI 命令名
  fallbackBins?: string[];       // 备用命令名
  versionArgs: string[];         // 用于探测版本的参数
  buildArgs: (prompt, options, context) => string[]; // 构造启动参数
  streamFormat: string;          // 输出流解析格式
  eventParser?: string;          // 事件解析器变体
  promptViaStdin?: boolean;      // 是否通过 stdin 发送 prompt
  promptInputFormat?: 'text' | 'stream-json';
  multiTurn?: boolean;           // 是否支持多轮对话
  fallbackModels: RuntimeModelOption[];
  install?: InstallConfig;       // 一键安装配置
}
```

这是**策略模式**的典型应用：RunManager 只依赖接口，不关心具体运行时。新增一个运行时，只需要实现一个符合此接口的对象，然后在 `registry.ts` 中注册。

## 4.5 ChatMessage 与 ToolEvent

`ChatMessage` 是持久化到 SQLite 的对话消息格式：

```typescript
// packages/contracts/src/api.ts
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  agentId?: string;
  runId?: string;
  thinking?: string;      // 仅 assistant
  tools?: ToolEvent[];    // 仅 assistant
  usage?: { input?: number; output?: number; cost?: number };
}
```

`ToolEvent` 记录一次工具调用的完整生命周期：

```typescript
interface ToolEvent {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'done' | 'error';
}
```

**关键区别**：`AgentEvent` 是流式的（text_delta），`ChatMessage` 是累积的（content 是完整字符串）。daemon 的 `TurnTextCollector` 负责将前者聚合为后者，再写入 SQLite。

## 4.6 SSEEnvelope：传输层封装

SSE 传输时，每个事件都包在一个信封里：

```typescript
// packages/contracts/src/sse.ts
interface SSEEnvelope {
  seq: number;          // 事件序列号（用于重放）
  runId: string;
  event: AgentEvent;
}
```

`seq` 字段是实现**断线重连**的关键：客户端重连时带上 `afterId`，服务端从缓冲区重放缺失的事件。

## 4.7 Knowledge 与 Graph

知识库相关类型描述了 Vault、文件树、Wiki 操作和知识图谱：

```typescript
// packages/contracts/src/knowledge.ts
interface Vault {
  id: string;
  name: string;
  path: string;          // 本地绝对路径
  fileCount: number;
  createdAt: number;
}

type WikiOperationType = 'build' | 'ingest' | 'lint' | 'query' | 'save';

interface GraphNode {
  key: string;           // 文件路径
  label: string;         // 显示名称
  path: string;
  linkCount: number;     // 被引用次数
  nodeType?: string;
  deadLink?: boolean;    // 是否是死链
}
```

`WikiOperationType` 五种操作对应 Wiki 系统的核心能力：构建索引、导入文件、健康检查、查询、归档。

## 4.8 类型如何流转

一次完整的对话请求，类型在系统中的流转路径：

```
Web UI                              Daemon
──────                              ──────
useChat.send()
  │
  ├─→ api.createRun() ──────────→  POST /api/runs
  │     (CreateRunRequest)           (CreateRunRequest)
  │                                       │
  │                                       ├─→ runManager.createRun()
  │                                       │     (spawn 子进程)
  │                                       │
  │                                       ├─→ stdout → StreamHandler
  │                                       │     (AgentEvent)
  │                                       │
  │     SSE (SSEEnvelope)  ←─────────    emitEvent()
  │     AgentEvent                        (AgentEvent 装入信封)
  │        │
  │        ├─→ text_delta → useChatCore → 更新消息
  │        ├─→ tool_use   → ToolCard    → 渲染工具卡片
  │        └─→ turn_end   → 解锁输入框
  │
  ├─→ conversations.appendMessage()
  │     (ChatMessage 写入 SQLite)
```

## 小结

- **contracts 是类型中枢**：零运行时开销，保证前后端类型严格一致
- **AgentEvent 是事件协议**：10 种事件类型覆盖完整的 Agent 生命周期
- **RuntimeAgentDef 是策略模式**：新增运行时只需实现接口
- **ChatMessage 是累积态**：由流式 AgentEvent 聚合而来，持久化到 SQLite
- **SSEEnvelope 支持重放**：seq 字段实现断线恢复
