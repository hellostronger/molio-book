---
layout: home
hero:
  name: Molio 源码解析
  text: 本地知识管理 + AI 写作 + 多平台发布
  tagline: 深入拆解 Molio 的架构设计、Agent 编排引擎与跨平台发布系统
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-what-is-molio
    - theme: alt
      text: 查看目录
      link: /contents
    - theme: alt
      text: GitHub
      link: https://github.com/zhuzhaoyun/Molio

features:
  - icon: 🤖
    title: 多运行时 Agent 编排
    details: 统一抽象 Claude Code / Codex / Gemini / Qwen 四大 AI 运行时，通过 stream-json 协议实现多轮对话与工具调用
  - icon: 📡
    title: SSE 实时事件流
    details: 从 daemon 进程到浏览器前端，端到端的 Server-Sent Events 推送架构，支持事件重放与断线恢复
  - icon: 🗂️
    title: 兼容 Obsidian Vault
    details: 直接打开 Obsidian 知识库目录，零迁移成本；纯 Markdown 文件，AI 驱动的 Wiki 构建与知识图谱
  - icon: 💬
    title: 微信 AI 助手
    details: 扫码连接个人微信，在手机端与本地知识库对话；统一会话服务支持跨渠道上下文管理
---
