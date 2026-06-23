import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Molio 源码解析',
  description: '本地知识管理 + AI 写作 + 多平台发布 — 架构内幕',
  lang: 'zh-CN',

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: '开始阅读', link: '/chapters/01-what-is-molio' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/zhuzhaoyun/Molio' },
    ],

    sidebar: [
      {
        text: '第一部分 · 宏观认知',
        items: [
          { text: '第 1 章 Molio 是什么，为什么重要', link: '/chapters/01-what-is-molio' },
          { text: '第 2 章 仓库概览与技术栈', link: '/chapters/02-repo-overview' },
          { text: '第 3 章 快速开始', link: '/chapters/03-quick-start' },
        ],
      },
      {
        text: '第二部分 · 核心引擎',
        items: [
          { text: '第 4 章 类型契约：contracts 的统一语言', link: '/chapters/04-contracts' },
          { text: '第 5 章 RunManager：AI Agent 编排的核心引擎', link: '/chapters/05-run-manager' },
          { text: '第 6 章 Stream Parser：将混沌输出变为结构化事件', link: '/chapters/06-stream-parser' },
          { text: '第 7 章 Runtime Registry：多 Agent 运行时的统一抽象', link: '/chapters/07-runtime-registry' },
          { text: '第 8 章 SQLite 持久层：对话、项目与知识库', link: '/chapters/08-persistence' },
          { text: '第 9 章 SSE 事件推送：实时数据流的端到端设计', link: '/chapters/09-sse-transport' },
        ],
      },
      {
        text: '第三部分 · 扩展生态',
        items: [
          { text: '第 10 章 微信 AI 助手：跨渠道会话编排', link: '/chapters/10-weixin-service' },
          { text: '第 11 章 Knowledge Base：本地知识库管理', link: '/chapters/11-knowledge-base' },
          { text: '第 12 章 Wiki 系统：AI 驱动的知识构建', link: '/chapters/12-wiki-system' },
          { text: '第 13 章 Web UI：React 19 组件架构', link: '/chapters/13-web-ui' },
          { text: '第 14 章 Electron Desktop：桌面应用壳设计', link: '/chapters/14-electron' },
          { text: '第 15 章 自动更新与发布系统', link: '/chapters/15-auto-update' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '附录 A 阅读路径指南', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B API 参考', link: '/chapters/appendix-b-api-reference' },
          { text: '附录 C 术语表', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/zhuzhaoyun/Molio' },
    ],

    footer: {
      message: '基于 Modified Apache 2.0 许可证发布',
      copyright: 'Copyright © 2024-present Molio Contributors',
    },

    search: {
      provider: 'local',
    },

    outline: {
      label: '页面导航',
      level: [2, 3],
    },
  },
})
