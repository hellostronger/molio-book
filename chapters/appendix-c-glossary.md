# 附录 C 术语表

> 本术语表收录了 Molio 源码中的核心概念和技术术语，帮助读者快速理解代码中的专业词汇。

## C

### Agent
AI 运行时实例。Molio 支持多种 Agent，如 Claude Code、Codex、Gemini CLI、Qwen Code。每个 Agent 都是一个独立的 CLI 工具，通过 `child_process.spawn` 启动。

### AgentEvent
统一的事件协议，定义了 Agent 运行过程中可能发生的所有事件。包括 `text_delta`（文本增量）、`tool_use`（工具调用）、`turn_end`（回合结束）等 10 种事件类型。

### AgentInfo
Agent 的元信息，包括 ID、名称、是否可用、二进制路径、版本号、支持的模型列表等。

## B

### better-sqlite3
Node.js 的 SQLite 绑定库，提供同步 API。Molio 使用它存储项目、会话、消息等持久化数据。

### BufferedEvent
缓冲的事件记录，包含事件 ID、事件类型、事件数据和时间戳。用于 SSE 重放和断线恢复。

## C

### Channel
外部通信渠道。Molio 目前支持微信（weixin）渠道，未来可扩展飞书、企业微信等。Channel 只负责消息收发，不管理长期会话历史。

### Claude Code
Anthropic 的 AI 编程助手 CLI 工具。Molio 通过 `stream-json` 格式与其交互，支持多轮对话和工具调用。

### contracts
共享类型包 `@molio/contracts`，定义了 daemon、web、desktop 三个运行时共用的 TypeScript 类型。

### Conversation
会话，是 Molio 中对话的基本单位。每个会话属于一个项目，包含多条消息。会话可以来自桌面端（channel_type: desktop）或外部渠道（channel_type: weixin）。

### ConversationService
统一会话服务，负责跨渠道的会话管理。提供创建、查询、追加消息等功能。

### CORS
跨域资源共享（Cross-Origin Resource Sharing）。daemon 配置了 CORS 中间件，允许来自 `localhost:5173`（Vite 开发服务器）和 `localhost:3100`（生产模式）的请求。

## D

### daemon
Molio 的后端服务，基于 Hono 框架。负责 Agent 编排、SSE 推送、数据持久化、知识库管理等核心功能。

### doocs/md
开源的 Markdown 排版引擎，Molio 将其核心代码 vendor 到 `apps/web/vendor/doocs-md/`，用于知识库的 Markdown 渲染和排版。

### doocs/cose
开源的多平台内容发布系统，Molio 集成了它的发布能力，支持一键发布到微信公众号、知乎、掘金等平台。

## E

### ELECTRON_RUN_AS_NODE
Electron 的环境变量，设置为 `1` 时让 Electron 二进制表现为标准 Node.js 进程。Molio 用此特性在桌面应用中运行 daemon，无需用户单独安装 Node.js。

### electron-builder
Electron 应用打包工具，用于将 Molio 打包为 Windows 安装程序（NSIS）。

### electron-updater
Electron 应用的自动更新库，Molio 通过它实现从 GitHub Releases 检查和下载更新。

### emitEvent
RunManager 的内部方法，负责将 AgentEvent 分发到三个目标：内存缓冲、JSONL 日志、SSE 监听器。

## F

### ForceAtlas2
图布局算法，Molio 在知识图谱可视化中使用它进行力导向布局。通过 `graphology-layout-forceatlas2` 库实现。

## G

### Graphology
图数据结构库，Molio 用它存储知识图谱的节点和边。

## H

### Hono
轻量级 Web 框架，Molio daemon 基于 Hono 构建 HTTP API 和 SSE 传输层。

## J

### JSONL
JSON Lines 格式，每行一个 JSON 对象。Molio 使用 JSONL 记录 Agent 运行的事件日志，便于事后分析和调试。

## K

### Knowledge Base（知识库）
Molio 的本地知识库管理模块，支持 Obsidian Vault 兼容、文件树浏览、Markdown 渲染、Wiki 构建等功能。

## M

### maybeCloseStdin
RunManager 的内部方法，根据当前状态决定是否关闭 Agent 进程的 stdin。考虑因素包括：是否有待回答的工具调用、Agent 是否在等待工具结果、是否支持多轮对话。

### molio://
自定义协议，允许外部应用（如 Chrome 扩展）唤起 Molio 桌面端。支持打开指定 vault 的文件或启动应用。

### Monorepo
单一代码仓库，Molio 使用 pnpm workspace 管理四个子包：contracts、daemon、web、desktop。

## N

### NSIS
Nullsoft Scriptable Install System，Windows 安装程序制作工具。Molio 使用 electron-builder 生成 NSIS 安装程序。

## O

### Obsidian
流行的本地知识库管理工具。Molio 兼容 Obsidian Vault 格式，可以直接打开 Obsidian 的知识库目录。

## P

### pnpm
快速、节省磁盘空间的包管理工具，Molio 使用 pnpm workspace 管理 monorepo。

### preload
Electron 的预加载脚本，在渲染进程加载网页之前执行。Molio 的 preload 脚本通过 `contextBridge` 暴露安全的 API 给前端。

### Project
项目，Molio 中的顶层组织单位。每个项目包含多个会话。系统使用两个隐藏的系统项目：`__molio_channels__`（外部渠道会话）和 `__molio_desktop__`（桌面端会话）。

## R

### ReadableStream
Web API 的可读流接口，Molio 使用它实现 SSE 传输层。

### Registry
运行时注册表，存储所有 RuntimeAgentDef 定义。提供 `getAgentDef()` 和 `listAgentDefs()` 方法。

### Run
Agent 的一次执行。每次创建 run 都会 spawn 一个子进程，运行 Agent CLI 工具。run 有生命周期状态：running → succeeded/failed/canceled。

### RunManager
Molio 的核心引擎，管理所有活跃 run 的生命周期。职责包括：进程 spawn、事件解析、多轮对话、stdin 管理、事件缓冲、SSE 推送。

### RunState
run 的运行时状态，包括：run ID、Agent ID、子进程引用、stdin 状态、事件监听器、事件缓冲、文本累积器等。

### RuntimeAgentDef
运行时定义接口，描述一个 AI 运行时的所有配置：命令名、启动参数、流格式、是否支持多轮对话、安装配置等。

## S

### selectParser
RunManager 的内部方法，根据运行时的 `streamFormat` 选择合适的流解析器（claude-stream-json、json-event-stream、plain text）。

### SemVer
语义化版本（Semantic Versioning），Molio 遵循 `MAJOR.MINOR.PATCH` 格式。预发布版本使用 `-beta.N` 或 `-rc.N` 后缀。

### Sigma.js
WebGL 图可视化库，Molio 用它渲染知识图谱。支持大规模图的实时交互。

### spawn
Node.js 的 `child_process.spawn` 方法，用于启动子进程。Molio 通过 spawn 启动 Agent CLI 工具。

### SSE
Server-Sent Events，服务端推送事件。Molio 使用 SSE 将 Agent 运行事件实时推送给前端。

### SSEEnvelope
SSE 传输信封，包装 AgentEvent 并添加序列号（seq）和 runId。格式：`{ seq, runId, event }`。

### StreamHandler
流解析器接口，定义 `feed(chunk)` 和 `flush()` 方法。负责将 Agent 的 stdout 输出解析为 AgentEvent。

### Stream-json
Claude Code 的交互格式，通过 stdin/stdout 传输 JSON 格式的消息。支持多轮对话和工具调用。

### system-hint
系统提示前缀，Molio 在发送给 Agent 的第一条消息中注入运行时身份信息，让 Agent 知道自己运行在 Molio 中。

## T

### tool_use
AgentEvent 类型之一，表示 Agent 调用了工具。包含工具 ID、名称、输入参数。

### tool_result
AgentEvent 类型之一，表示工具调用的结果。包含工具 ID、结果内容、是否错误。

### trash
Node.js 库，将文件移动到系统回收站而非永久删除。Molio 用它实现安全的文件删除。

### TurnTextCollector
文本累积器，将流式的 `text_delta` 事件累积为完整的回复文本，并在回合结束时调用回调函数持久化到数据库。

### turn_end
AgentEvent 类型之一，表示一个回合结束。包含停止原因（end_turn 或 tool_use）。

## V

### Vault
本地知识库，对应文件系统中的一个目录。Molio 管理多个 vault，每个 vault 包含 Markdown 文件、图片等。

### Vite
现代前端构建工具，Molio web 使用 Vite 进行开发和构建。

## W

### WAL
Write-Ahead Logging，SQLite 的日志模式。Molio 启用 WAL 模式以提高并发读写性能。

### WebUI First
Molio 的设计原则：所有业务逻辑在 Web 层实现，Electron 只是一个壳。E2E 测试直接测 Web 层。

### weixin
微信渠道模块，负责微信扫码登录、消息轮询、消息处理、回复发送。通过 ConversationService 与统一会话系统集成。

### WeixinService
微信服务类，管理微信连接状态、登录流程、消息轮询、健康探针。是 Molio 最复杂的业务模块之一。

### Wiki
Molio 的 AI 驱动知识构建系统，支持五种操作：build（构建索引）、ingest（导入文件）、lint（健康检查）、query（知识查询）、save（对话归档）。

### WikiOperationType
Wiki 操作类型枚举：`build` | `ingest` | `lint` | `query` | `save`。

## 小结

本术语表涵盖了 Molio 源码中的核心概念，从 Agent 编排、事件流、持久化到桌面应用、自动更新。掌握这些术语有助于快速理解代码结构和设计意图。
