# 第 14 章 Electron Desktop：桌面应用壳设计

> Electron 是 Molio 的桌面应用壳。它负责启动 daemon 子进程、创建 BrowserWindow、注册自定义协议、处理自动更新。本章将拆解它的架构设计、进程管理、协议注册机制。

## 14.1 设计哲学

Molio 的桌面应用遵循 **WebUI First** 原则：

- **所有业务逻辑在 Web 层**：Electron 只是一个壳
- **E2E 测试直接测 Web 层**：不需要 Electron 环境
- **Electron 只负责**：
  - 启动 daemon 子进程
  - 创建和管理窗口
  - 注册自定义协议 (`molio://`)
  - 处理系统级功能（自动更新、文件关联）

## 14.2 进程架构

```
┌─────────────────────────────────────────┐
│           Electron Main Process         │
│  (src/main.js)                          │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  BrowserWindow                    │ │
│  │  - 加载 http://localhost:3100     │ │
│  │  - 运行 React 应用                │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  Daemon 子进程                    │ │
│  │  - ELECTRON_RUN_AS_NODE=1         │ │
│  │  - 运行 daemon/dist/index.js      │ │
│  │  - 监听 :3100                     │ │
│  └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## 14.3 开发模式 vs 生产模式

### 14.3.1 开发模式

```javascript
// apps/desktop/src/main.js
function isDevMode() {
  return !app.isPackaged;
}

if (isDevMode()) {
  mainWindow.loadURL('http://localhost:5173'); // Vite dev server
}
```

- **daemon**：由 `pnpm dev:daemon` 独立启动（tsx watch）
- **web**：由 Vite dev server 提供（HMR，端口 5173）
- **Electron**：加载 `http://localhost:5173`

### 14.3.2 生产模式

```javascript
// apps/desktop/src/main.js
if (!isDevMode()) {
  await startDaemonProduction(); // 启动 daemon 子进程
  mainWindow.loadURL('http://localhost:3100'); // daemon 提供静态文件
}
```

- **daemon**：作为 Electron 内置 Node.js 子进程运行
- **web**：构建产物由 daemon 提供静态文件服务
- **Electron**：加载 `http://localhost:3100`

## 14.4 ELECTRON_RUN_AS_NODE

这是 Molio 桌面应用的关键创新：

```javascript
function startDaemonProduction() {
  const daemonEntry = path.join(process.resourcesPath, 'daemon', 'daemon.mjs');
  const webStaticDir = path.join(process.resourcesPath, 'web');

  daemonProcess = spawn(process.execPath, [daemonEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // 让 Electron 二进制表现为 Node.js
      MOLIO_PORT: '3100',
      MOLIO_STATIC_DIR: webStaticDir,
    },
    stdio: 'pipe',
  });
}
```

**优势**：
- **无需用户安装 Node.js**：Electron 内置 Node.js 24.11.1
- **版本一致性**：daemon 使用的 Node.js 版本与 Electron 一致
- **简化分发**：只需分发 Electron 应用

**工作原理**：
- `process.execPath` 是 Electron 二进制文件路径
- `ELECTRON_RUN_AS_NODE=1` 让它表现为标准 Node.js 进程
- daemon 代码作为普通 Node.js 脚本运行

## 14.5 窗口管理

```javascript
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Molio',
    show: false, // 先隐藏，等 ready-to-show 再显示
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // 安全：隔离上下文
      nodeIntegration: false, // 安全：禁用 Node 集成
      webSecurity: true,
    },
  });

  // 避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // 拦截 window.open()，在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}
```

**关键设计**：
- **show: false**：先隐藏窗口，等内容加载完成再显示，避免白屏
- **contextIsolation: true**：安全隔离，防止 XSS 攻击
- **nodeIntegration: false**：禁用 Node 集成，提高安全性
- **拦截 window.open()**：在系统浏览器中打开外部链接（如 COSE 发布）

## 14.6 自定义协议注册

Molio 注册了 `molio://` 自定义协议，允许外部应用（如 Chrome 扩展）唤起桌面端：

```javascript
const PROTOCOL = 'molio';

// macOS：在 app ready 之前注册
if (process.platform === 'darwin') {
  if (!app.isDefaultProtocolClient(PROTOCOL)) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

// Windows：在 app ready 之后注册
app.whenReady().then(() => {
  if (process.platform !== 'darwin') {
    const ok = app.setAsDefaultProtocolClient(PROTOCOL);
    if (ok) {
      log('info', 'main', `Protocol '${PROTOCOL}://' registered successfully`);
    }
  }
});
```

**协议格式**：

```
molio://open/vault/<vaultId>/file/<filePath>  // 打开指定 vault 的文件
molio://open/file/<filePath>                  // 打开当前 vault 的文件
molio://launch                                 // 启动应用
```

**使用场景**：
- **Chrome 扩展**：剪藏网页后，通过 `molio://` 协议唤起桌面端并定位到文件
- **其他应用**：通过 URL Scheme 打开 Molio

## 14.7 单实例锁

```javascript
const singleLock = app.requestSingleInstanceLock();

if (!singleLock) {
  app.quit(); // 已有实例运行，退出
} else {
  app.on('second-instance', (_event, commandLine) => {
    // 第二个实例启动时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    
    // 处理 molio:// 协议 URL
    const protocolUrl = commandLine.find(arg => arg.startsWith('molio://'));
    if (protocolUrl) {
      navigateFromProtocolUrl(protocolUrl);
    }
  });
}
```

**作用**：
- **防止多开**：只允许一个 Molio 实例运行
- **协议处理**：第二个实例的命令行参数包含协议 URL，传递给第一个实例处理

## 14.8 协议 URL 处理

```javascript
function parseMolioProtocolUrl(protocolUrl) {
  const vaultFileMatch = protocolUrl.match(/^molio:\/\/open\/vault\/([^/]+)\/file\/(.+)$/);
  if (vaultFileMatch) {
    return {
      action: 'open-file',
      vaultId: decodeURIComponent(vaultFileMatch[1]),
      filePath: decodeURIComponent(vaultFileMatch[2]),
    };
  }

  const fileOnlyMatch = protocolUrl.match(/^molio:\/\/open\/file\/(.+)$/);
  if (fileOnlyMatch) {
    return {
      action: 'open-file',
      vaultId: null,
      filePath: decodeURIComponent(fileOnlyMatch[1]),
    };
  }

  if (protocolUrl.startsWith('molio://launch')) {
    return { action: 'launch' };
  }

  return null;
}

function navigateFromProtocolUrl(protocolUrl) {
  const target = parseMolioProtocolUrl(protocolUrl);
  
  if (target?.action === 'open-file') {
    const params = new URLSearchParams();
    if (target.vaultId) params.set('vault', target.vaultId);
    params.set('file', target.filePath);
    mainWindow.loadURL(`http://localhost:3100/knowledge?${params.toString()}`);
    return;
  }

  if (target?.action === 'launch') {
    if (isShowingSplash()) {
      loadApp(); // 从 splash 切换到真实应用
    }
    return;
  }
}
```

**关键设计**：
- **路径式 URL**：使用路径而非查询参数，因为 Windows shell 会破坏 `?` 和 `&`
- **导航到知识库页面**：通过 URL 参数传递 vault 和 file
- **Web 端负责选中文件**：Electron 只负责导航，Web 端等待文件树加载后选中文件

## 14.9 应用生命周期

```javascript
app.whenReady().then(async () => {
  // 1. 创建窗口（updater IPC 需要窗口引用）
  createWindow();

  // 2. 设置自动更新（必须在 daemon 之前）
  setupAutoUpdater(() => mainWindow, killDaemon);

  // 3. 启动 daemon（最后启动）
  if (!isDevMode()) {
    try {
      await startDaemonProduction();
    } catch (err) {
      log('error', 'main', `daemon startup failed: ${err.message}`);
      showDaemonErrorPage();
    }
  }

  // 4. 加载应用或处理协议 URL
  if (daemonReady) {
    const protocolUrl = process.argv.find(arg => arg.startsWith('molio://'));
    if (protocolUrl) {
      setTimeout(() => navigateFromProtocolUrl(protocolUrl), 500);
    } else {
      loadApp();
    }
  }
});

app.on('before-quit', (event) => {
  if (daemonProcess) {
    event.preventDefault(); // 阻止立即退出
    killDaemon().then(() => {
      app.quit(); // daemon 退出后再退出
    });
  }
});
```

**启动顺序**：
1. **创建窗口**：updater 需要窗口引用进行 IPC
2. **设置自动更新**：即使 daemon 启动失败，updater 仍需工作
3. **启动 daemon**：最后启动，失败不影响 updater
4. **加载应用**：如果有协议 URL，导航到目标页面

**退出顺序**：
1. **阻止立即退出**：`event.preventDefault()`
2. **杀死 daemon**：等待 daemon 完全退出
3. **应用退出**：daemon 退出后再退出 Electron

## 14.10 Daemon 进程管理

```javascript
async function killDaemon() {
  if (!daemonProcess) return;

  // 1. 请求优雅关闭
  requestDaemonShutdown(); // POST /api/shutdown

  // 2. 强制杀死（5 秒超时）
  const forceTimer = setTimeout(() => {
    forceKillDaemon(daemonProcess.pid);
  }, 5000);

  // 3. 等待退出
  await new Promise((resolve) => {
    daemonProcess.once('exit', () => {
      clearTimeout(forceTimer);
      // 等待 2 秒让 OS 释放文件句柄
      setTimeout(resolve, 2000);
    });
  });
}

function requestDaemonShutdown() {
  fetch('http://localhost:3100/api/shutdown', { method: 'POST' }).catch(() => {
    // 网络错误是预期的（daemon 正在关闭）
  });
}

function forceKillDaemon(pid) {
  if (process.platform === 'win32') {
    // Windows：使用 taskkill 杀死进程树
    execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 });
  } else {
    // Unix：使用 SIGKILL
    daemonProcess?.kill('SIGKILL');
  }
}
```

**关键设计**：
- **两级杀死**：先请求优雅关闭，超时后强制杀死
- **Windows 特殊处理**：使用 `taskkill /F /T` 杀死进程树
- **等待文件句柄释放**：Windows 上杀死进程后，需要等待 OS 释放文件锁（2 秒）
- **daemon 关闭端点**：`POST /api/shutdown` 让 daemon 刷新数据并退出

## 14.11 IPC 通信

```javascript
// main.js
ipcMain.handle('show-directory-picker', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择本地仓库文件夹',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-path', async (_, filePath) => {
  return shell.openPath(filePath);
});

// preload.cjs
contextBridge.exposeInMainWorld('electronAPI', {
  showDirectoryPicker: () => ipcRenderer.invoke('show-directory-picker'),
  openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
});

// web 端使用
const dir = await window.electronAPI.showDirectoryPicker();
```

**安全设计**：
- **contextBridge**：通过预加载脚本暴露 API，而非直接暴露 ipcRenderer
- **invoke/handle**：使用 Promise 风格的异步通信
- **类型安全**：`electron.d.ts` 定义类型

## 14.12 崩溃保护

```javascript
// 全局异常处理
process.on('uncaughtException', (err) => {
  log('error', 'main', `uncaughtException: ${err.message}`);
  
  // 内存错误或 IPC 断开 → 5 秒后退出
  if (err.code === 'ENOMEM' || err.code === 'ERR_IPC_CHANNEL_CLOSED') {
    setTimeout(() => app.quit(), 5000);
  }
});

process.on('unhandledRejection', (reason) => {
  log('error', 'main', `unhandledRejection: ${reason}`);
  // 不退出，保持 updater 运行
});
```

**设计原则**：
- **updater 必须存活**：即使其他模块崩溃，updater 仍需工作以推送修复
- **致命错误延迟退出**：给用户时间保存数据

## 14.13 打包配置

```javascript
// apps/desktop/scripts/prepare-resources.mjs (简化)
// 1. 使用 esbuild 打包 daemon
await esbuild.build({
  entryPoints: ['apps/daemon/dist/index.js'],
  bundle: true,
  platform: 'node',
  outfile: 'resources/daemon/daemon.mjs',
  external: ['better-sqlite3'], // 原生模块不打包
});

// 2. 复制 web 构建产物
fs.cpSync('apps/web/dist', 'resources/web', { recursive: true });

// 3. 复制原生依赖
fs.cpSync('node_modules/better-sqlite3', 'resources/daemon/node_modules/better-sqlite3', { recursive: true });
```

```jsonc
// apps/desktop/electron-builder.json5
{
  "appId": "com.molio.app",
  "productName": "Molio",
  "directories": {
    "output": "dist"
  },
  "files": [
    "src/**/*"
  ],
  "extraResources": [
    {
      "from": "resources/daemon",
      "to": "daemon"
    },
    {
      "from": "resources/web",
      "to": "web"
    }
  ],
  "win": {
    "target": "nsis"
  },
  "nsis": {
    "oneClick": false, // 允许用户选择安装目录
    "allowToChangeInstallationDirectory": true
  },
  "asarUnpack": [
    "node_modules/better-sqlite3/**/*" // 原生模块不打包进 asar
  ]
}
```

**关键配置**：
- **extraResources**：daemon 和 web 构建产物放在 resources 目录
- **asarUnpack**：原生模块（better-sqlite3）不打包进 asar
- **NSIS 安装程序**：允许用户选择安装目录

## 14.14 构建命令

```bash
# 一键构建 + 生成未打包版本
pnpm desktop:run

# 完整打包
pnpm package

# 仅生成未打包目录
pnpm package:dir
```

**构建流程**：
1. `pnpm --filter @molio/contracts build`
2. `pnpm --filter @molio/daemon build`
3. `pnpm --filter @molio/web build`
4. `node scripts/prepare-resources.mjs`
5. `npx electron-builder --win`

## 小结

- **WebUI First**：所有业务逻辑在 Web 层，Electron 只是壳
- **ELECTRON_RUN_AS_NODE**：让 Electron 内置 Node.js 运行 daemon
- **自定义协议**：`molio://` 允许外部应用唤起桌面端
- **单实例锁**：防止多开，处理协议 URL
- **进程管理**：两级杀死（优雅关闭 + 强制杀死）
- **崩溃保护**：updater 必须存活，致命错误延迟退出
- **打包配置**：原生模块不打包进 asar，NSIS 安装程序
