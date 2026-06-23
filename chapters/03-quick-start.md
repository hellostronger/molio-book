# 第 3 章 快速开始

> 本章介绍如何搭建开发环境、运行项目、执行测试，以及理解项目的构建流程。读完本章后，你应该能在本地完整运行 Molio 并开始修改代码。

## 3.1 前置要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Node.js | >= 22 | 运行时（daemon 使用 24+） |
| pnpm | >= 9 | 包管理 |
| AI CLI (至少一个) | - | Claude Code / Codex / Gemini / Qwen |

## 3.2 安装与运行

```bash
# 克隆项目
git clone https://github.com/zhuzhaoyun/Molio.git
cd Molio

# 安装依赖
pnpm install

# 开发模式 — daemon + web 同时启动
pnpm dev
# daemon: http://localhost:3100
# web:    http://localhost:5173

# 或分别启动
pnpm dev:daemon   # 仅后端
pnpm dev:web      # 仅前端

# 桌面应用开发模式
pnpm dev:desktop  # daemon + web + Electron
```

## 3.3 开发模式 vs 生产模式

### 开发模式

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Electron   │────→│  Vite :5173  │     │  tsx :3100   │
│  (main.js)   │     │  (web HMR)   │     │  (daemon)    │
└──────────────┘     └──────────────┘     └──────────────┘
                           ↑                     ↑
                     开发时加载            API + SSE
```

- daemon 由 `tsx watch` 启动，支持热重载
- web 由 Vite 提供 HMR
- Electron 加载 `http://localhost:5173`

### 生产模式 (桌面应用)

```
┌──────────────────────────────────────────────────┐
│                   Electron                        │
│  ┌─────────────────────────────────────────────┐ │
│  │  BrowserWindow → http://localhost:3100       │ │
│  └─────────────────────────────────────────────┘ │
│                        ↑                         │
│  ┌─────────────────────────────────────────────┐ │
│  │  Daemon (ELECTRON_RUN_AS_NODE=1)             │ │
│  │  • API 路由                                  │ │
│  │  • SSE 推送                                  │ │
│  │  • 静态文件服务 (MOLIO_STATIC_DIR)           │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

- Electron 使用内置 Node.js 启动 daemon 子进程
- `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制表现为 Node.js
- Daemon 同时提供 API 和 Web 静态文件服务
- 无需用户单独安装 Node.js

## 3.4 构建桌面应用

```bash
# 一键构建 + 生成未打包版本 (win-unpacked)
pnpm desktop:run

# 完整打包为安装程序
pnpm package

# 仅生成未打包目录
pnpm package:dir
```

构建流程：

1. `pnpm --filter @molio/contracts build` — 编译共享类型
2. `pnpm --filter @molio/daemon build` — 编译 daemon TypeScript
3. `pnpm --filter @molio/web build` — 构建 web Vite 产物
4. `node scripts/prepare-resources.mjs` — esbuild 打包 daemon + 复制资源
5. `npx electron-builder --win` — 打包为 Windows 安装程序

## 3.5 测试策略

### 单元/集成测试 (node:test)

```bash
pnpm test  # daemon + desktop 测试
```

测试文件按源码模块组织：

| 源码模块 | 测试目录 |
|---------|---------|
| `daemon/src/core/` | `daemon/test/core/` |
| `daemon/src/core/streams/` | `daemon/test/streams/` |
| `daemon/src/core/runtimes/` | `daemon/test/runtimes/` |
| `daemon/src/routes/` | `daemon/test/routes/` |
| `desktop/src/` | `desktop/test/` |

### E2E 测试 (Playwright)

```bash
# 前置：pnpm dev 运行中
pnpm test:e2e

# 或带 UI
npx playwright test --ui --headed
```

E2E 直接测试 Web 层，因为 "WebUI First" 原则：

```typescript
// apps/web/e2e/bootstrap.spec.ts
test('should show agent selector', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await expect(page.locator('[data-testid="agent-selector"]')).toBeVisible();
});
```

## 3.6 类型检查

```bash
pnpm typecheck  # 全量类型检查所有子包
```

## 3.7 目录约定

### 数据目录

| 路径 | 内容 |
|------|------|
| `~/.molio/app.sqlite` | SQLite 数据库 (WAL 模式) |
| `~/.molio/config.json` | 用户配置 |
| `~/.molio/weixin-credentials.json` | 微信凭证 (0600 权限) |
| `~/.molio/runs/<runId>/events.jsonl` | Run 事件日志 |

### 配置文件

```jsonc
// ~/.molio/config.json
{
  "defaultAgentId": "claude",
  "defaultCwd": "/path/to/vault",
  "locale": "zh",
  "agents": {
    "claude": {
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  },
  "weixin": {
    "enabled": false,
    "defaultAgentId": "claude"
  }
}
```

## 3.8 调试技巧

### 查看 daemon 日志

```bash
# 开发模式直接看终端输出

# 生产模式查看 Electron 日志
cat ~/.molio/logs/main.log
```

### 查看 SSE 事件流

```bash
# 创建一个 run
curl -X POST http://localhost:3100/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"claude","message":"hello"}'

# 订阅 SSE 事件
curl -N http://localhost:3100/api/runs/<runId>/events
```

### 检查数据库

```bash
# 使用 sqlite3 CLI
sqlite3 ~/.molio/app.sqlite ".tables"
sqlite3 ~/.molio/app.sqlite "SELECT * FROM conversations LIMIT 5;"
```

## 小结

- **pnpm monorepo** 支持同时开发 daemon + web + desktop
- **开发模式** 使用 tsx + Vite 热重载，**生产模式** 使用 Electron 内嵌 Node.js
- **测试分层**：node:test 覆盖核心逻辑，Playwright 覆盖 UI 流程
- **数据全部本地**：SQLite + 文件系统，无外部依赖
