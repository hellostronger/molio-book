# 第 1 章 Molio 是什么，为什么重要

> 本章将从项目定位、核心特征、与竞品对比三个维度，帮助你建立对 Molio 的全局认知。读完本章后，你将理解 Molio 解决的核心问题是什么，以及它与其他知识管理工具有何本质区别。

## 1.1 从名字说起

**Molio**（墨流）取自"墨"（知识记录）与"流"（数据流转）的结合。它是一款**本地优先**的桌面应用，将三件原本独立的事情串联成一条流水线：

```
知识管理（输入）→ AI 写作（加工）→ 多平台发布（输出）
```

传统的知识管理工具（Obsidian、Notion）止步于"管理"；AI 写作工具（Claude Code、ChatGPT）止步于"生成"；发布工具（Markdown Nice、公众号编辑器）止步于"排版"。Molio 的独特之处在于它是第一个把这三件事打通的开源项目。

## 1.2 知识管理 vs AI 写作 vs 发布工具：本质区别

| 维度 | Molio | Obsidian | Notion | Claude Code |
|------|-------|----------|--------|-------------|
| **数据归属** | 本地文件系统 | 本地 Vault | 云端 | API 临时 |
| **AI 集成** | 原生多运行时 | 插件生态 | 内置 | 本身就是 |
| **发布能力** | 30+ 平台一键 | 无 | 有限 | 无 |
| **微信集成** | 原生支持 | 无 | 无 | 无 |
| **离线能力** | 完全离线可用 | 完全离线 | 部分离线 | 需要网络 |
| **开源程度** | Modified Apache 2.0 | 闭源 | 闭源 | 部分开源 |

## 1.3 Molio 的三个核心特征

**特征一：本地优先，数据自主。** 所有数据——知识库文件、AI 对话记录、微信消息——全部存储在用户自己的电脑上（`~/.molio/app.sqlite` + Vault 目录）。没有任何第三方服务器参与数据流转。这意味着你的知识资产不会因为某个服务停服而丢失。

**特征二：多运行时 Agent 编排。** Molio 不绑定任何单一 AI 模型。它通过统一的 `RuntimeAgentDef` 接口抽象了四大 AI 运行时：

```typescript
// packages/contracts/src/agent.ts — 简化的运行时定义
interface RuntimeAgentDef {
  id: string;           // 'claude' | 'codex' | 'gemini' | 'qwen'
  name: string;
  bin: string;          // CLI 二进制名称
  streamFormat: string; // 输出流解析格式
  multiTurn?: boolean;  // 是否支持多轮对话
  buildArgs: (prompt, options, context) => string[];
}
```

每个运行时都是一个独立的 CLI 工具，Molio 通过 `child_process.spawn` 启动它们，解析 stdout 输出，通过 SSE 推送到前端。这种架构意味着：**新增一个 AI 运行时，只需要实现一个 `RuntimeAgentDef` 对象。**

**特征三：端到端发布流水线。** 写完文档只是第一步。Molio 集成了 doocs/md 排版引擎和 doocs/cose 发布系统，支持从 Markdown 到微信公众号、知乎、掘金等 30+ 平台的一键格式化发布。

## 1.4 发展历程

Molio 的演进可以划分为三个阶段：

1. **知识管理阶段**：最初是一个兼容 Obsidian Vault 的本地知识库浏览器，核心是文件树管理 + Markdown 渲染
2. **AI 集成阶段**：引入 Claude Code / Codex 图形界面，实现 Agent 编排引擎 (RunManager)，支持多轮对话与工具调用
3. **全渠道阶段**：接入微信 AI 助手、知识图谱 (Sigma.js)、多平台发布，形成完整的知识流转闭环

## 1.5 实际用例

**用例一：技术博客写作。** 在 Obsidian Vault 中积累素材 → 用 Chrome 扩展剪藏参考文章 → 在 Molio 中调用 Claude Code 撰写文章 → 使用 doocs/md 排版 → 一键发布到公众号、知乎、掘金。

**用例二：微信知识助手。** 扫码连接个人微信 → 在手机端向 AI 发送知识库相关问题 → Molio 在本地运行 Agent 查询 Vault → 将回答发回微信。

**用例三：团队知识管理。** 多人共享 Obsidian Vault → 各自在 Molio 中用不同 AI 运行时处理文档 → 通过 Wiki 系统自动构建知识索引 → 知识图谱可视化展示关联。

## 1.6 架构哲学

Molio 的架构设计遵循三个核心原则：

1. **WebUI First**：所有业务逻辑都在 Web 层实现，Electron 只是一个壳。这意味着 E2E 测试直接测 Web 层，核心功能不依赖桌面环境。

2. **Agent 即进程**：每个 AI 运行时都是一个独立的子进程，通过 stdin/stdout 通信。这种设计保证了进程隔离——一个 Agent 崩溃不会影响其他 Agent 或主进程。

3. **事件驱动**：从 daemon 的 `AgentEvent` 到前端的 SSE 订阅，整个系统围绕事件流构建。这使得实时渲染、断线恢复、多渠道转发成为可能。

## 小结

- **Molio 是一个端到端的知识流水线**：从管理到写作到发布，而非单一功能的工具
- **本地优先意味着数据主权**：所有数据存在用户自己的电脑上，不经过第三方
- **多运行时编排是核心差异化**：通过统一的 `RuntimeAgentDef` 接口，Molio 可以接入任何 AI CLI 工具
- **事件驱动的架构**让实时交互、跨渠道转发、断线恢复成为可能
