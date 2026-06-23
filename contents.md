# 目录

Molio 源码解析 — 共 15 章 + 3 个附录

## 第一部分 · 宏观认知

| 章节 | 主题 | 关键词 |
|------|------|--------|
| [第 1 章](./chapters/01-what-is-molio.md) | Molio 是什么，为什么重要 | 本地优先、多运行时、知识发布 |
| [第 2 章](./chapters/02-repo-overview.md) | 仓库概览与技术栈 | pnpm monorepo、Hono + React + Electron |
| [第 3 章](./chapters/03-quick-start.md) | 快速开始 | 安装运行、开发调试、测试策略 |

## 第二部分 · 核心引擎

| 章节 | 主题 | 关键词 |
|------|------|--------|
| [第 4 章](./chapters/04-contracts.md) | 类型契约：contracts 的统一语言 | AgentEvent、RuntimeAgentDef、共享类型 |
| [第 5 章](./chapters/05-run-manager.md) | RunManager：AI Agent 编排的核心引擎 | 进程生命周期、事件缓冲、多轮对话 |
| [第 6 章](./chapters/06-stream-parser.md) | Stream Parser：将混沌输出变为结构化事件 | JSONL 解析、claude-stream-json、状态机 |
| [第 7 章](./chapters/07-runtime-registry.md) | Runtime Registry：多 Agent 运行时的统一抽象 | 注册表模式、二进制探测、一键安装 |
| [第 8 章](./chapters/08-persistence.md) | SQLite 持久层：对话、项目与知识库 | better-sqlite3、WAL 模式、迁移策略 |
| [第 9 章](./chapters/09-sse-transport.md) | SSE 事件推送：实时数据流的端到端设计 | ReadableStream、事件重放、心跳保活 |

## 第三部分 · 扩展生态

| 章节 | 主题 | 关键词 |
|------|------|--------|
| [第 10 章](./chapters/10-weixin-service.md) | 微信 AI 助手：跨渠道会话编排 | 轮询架构、健康探针、统一会话 |
| [第 11 章](./chapters/11-knowledge-base.md) | Knowledge Base：本地知识库管理 | 文件树扫描、路径安全、doocs/md 集成 |
| [第 12 章](./chapters/12-wiki-system.md) | Wiki 系统：AI 驱动的知识构建 | Wiki 提示词、操作类型、知识图谱 |
| [第 13 章](./chapters/13-web-ui.md) | Web UI：React 19 组件架构 | useChat、SSE 消费、Sigma.js 图谱 |
| [第 14 章](./chapters/14-electron.md) | Electron Desktop：桌面应用壳设计 | ELECTRON_RUN_AS_NODE、协议注册、自动更新 |
| [第 15 章](./chapters/15-auto-update.md) | 自动更新与发布系统 | electron-updater、OSS 分发、版本策略 |

## 附录

| 附录 | 主题 |
|------|------|
| [附录 A](./chapters/appendix-a-reading-path.md) | 阅读路径指南 |
| [附录 B](./chapters/appendix-b-api-reference.md) | API 参考 |
| [附录 C](./chapters/appendix-c-glossary.md) | 术语表 |
