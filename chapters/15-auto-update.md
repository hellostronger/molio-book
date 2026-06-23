# 第 15 章 自动更新与发布系统

> 自动更新是桌面应用的关键功能。Molio 使用 electron-updater 实现自动更新，通过 GitHub Releases 分发安装包，并支持 beta/rc 预发布版本。本章将拆解它的更新流程、版本策略、OSS 分发机制。

## 15.1 更新架构

```
┌─────────────────────────────────────────┐
│         GitHub Releases                 │
│  - v0.3.22 (latest)                     │
│  - v0.3.23-beta.1 (pre-release)         │
│  - latest.yml / latest.json             │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         electron-updater                │
│  - 检查更新                             │
│  - 下载增量包                           │
│  - 验证签名                             │
│  - 安装更新                             │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│         Electron App                    │
│  - 杀死 daemon                          │
│  - 释放文件锁                           │
│  - 安装更新                             │
│  - 重启应用                             │
└─────────────────────────────────────────┘
```

## 15.2 版本策略

Molio 遵循语义化版本（SemVer）：

| 类型 | Tag 格式 | 示例 | 更新行为 |
|------|---------|------|---------|
| 正式版 | `vMAJOR.MINOR.PATCH` | `v0.3.22` | 所有用户收到更新 |
| Beta | `vMAJOR.MINOR.PATCH-beta.N` | `v0.3.22-beta.1` | 仅 beta 用户收到 |
| RC | `vMAJOR.MINOR.PATCH-rc.N` | `v0.3.22-rc.1` | 仅 rc 用户收到 |

**electron-updater 预发布规则**：
- **正式版用户**：只收到正式版更新
- **预发布用户**：收到同系列后续预发布 + 正式版
- **版本比较**：`0.3.22-beta < 0.3.22`（预发布版本永远低于同名正式版）

**示例**：
- 用户在 `0.3.22-beta.1`：
  - 收到 `0.3.22-beta.2` ✓
  - 收到 `0.3.22-rc.1` ✗（不同系列）
  - 收到 `0.3.22` ✓
- 用户在 `0.3.22`：
  - 收到 `0.3.23` ✓
  - 收到 `0.3.23-beta.1` ✗（预发布）

## 15.3 更新检查流程

```javascript
// apps/desktop/src/updater.js (简化)
import { autoUpdater } from 'electron-updater';

export function setupAutoUpdater(getMainWindow, killDaemon) {
  autoUpdater.autoDownload = false; // 不自动下载，先提示用户
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

  // 检查更新
  autoUpdater.checkForUpdates().catch((err) => {
    log('error', 'updater', `checkForUpdates failed: ${err.message}`);
  });

  // 发现更新
  autoUpdater.on('update-available', (info) => {
    log('info', 'updater', `Update available: ${info.version}`);
    
    const mainWindow = getMainWindow();
    if (mainWindow) {
      // 通知前端
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseNotes: info.releaseNotes,
      });
    }
  });

  // 下载进度
  autoUpdater.on('download-progress', (progress) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
      });
    }
  });

  // 下载完成
  autoUpdater.on('update-downloaded', async () => {
    log('info', 'updater', 'Update downloaded');
    
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded');
    }
  });

  // 错误处理
  autoUpdater.on('error', (err) => {
    log('error', 'updater', `Updater error: ${err.message}`);
  });
}
```

**关键配置**：
- **autoDownload: false**：不自动下载，先提示用户
- **autoInstallOnAppQuit: true**：退出时自动安装

## 15.4 用户交互流程

```typescript
// apps/web/src/components/UpdateNotification.tsx (简化)
export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    // 监听 updater 事件
    window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info);
    });

    window.electronAPI.onUpdateDownloadProgress((progress) => {
      setDownloadProgress(progress.percent);
    });

    window.electronAPI.onUpdateDownloaded(() => {
      setDownloaded(true);
    });
  }, []);

  const handleDownload = () => {
    window.electronAPI.downloadUpdate();
  };

  const handleInstall = () => {
    window.electronAPI.quitAndInstall();
  };

  if (!updateInfo) return null;

  return (
    <div className="update-notification">
      {downloaded ? (
        <>
          <p>更新已下载，点击安装</p>
          <button onClick={handleInstall}>立即安装</button>
        </>
      ) : (
        <>
          <p>新版本 {updateInfo.version} 可用</p>
          {downloadProgress > 0 ? (
            <div className="progress-bar">
              <div style={{ width: `${downloadProgress}%` }} />
            </div>
          ) : (
            <button onClick={handleDownload}>下载更新</button>
          )}
        </>
      )}
    </div>
  );
}
```

**流程**：
1. **发现更新**：显示通知
2. **用户点击"下载更新"**：开始下载
3. **下载进度**：显示进度条
4. **下载完成**：显示"立即安装"按钮
5. **用户点击"立即安装"**：杀死 daemon，安装更新，重启应用

## 15.5 安装更新

```javascript
// apps/desktop/src/main.js
ipcMain.handle('quit-and-install', async () => {
  // 1. 杀死 daemon（释放文件锁）
  await killDaemon();
  
  // 2. 安装更新并重启
  autoUpdater.quitAndInstall();
});
```

**关键步骤**：
- **杀死 daemon**：daemon 持有文件锁，不杀死会导致安装失败
- **等待文件句柄释放**：Windows 上杀死进程后，需要等待 2 秒让 OS 释放文件锁
- **quitAndInstall**：安装更新并重启应用

## 15.6 GitHub Actions 发布流程

```yaml
# .github/workflows/release.yml (简化)
name: Release

on:
  push:
    tags:
      - 'v*' # 触发条件：推送 v* 标签

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v2
        with:
          version: 11
      
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      
      - run: pnpm install
      
      - run: pnpm build
      
      - run: pnpm package
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Check if pre-release
        id: check
        run: |
          if echo "${{ github.ref_name }}" | grep -qiE '(test|beta|alpha|rc|dirty)'; then
            echo "prerelease=true" >> $GITHUB_OUTPUT
          else
            echo "prerelease=false" >> $GITHUB_OUTPUT
          fi
      
      - name: Update OSS latest files
        if: steps.check.outputs.prerelease == 'false'
        run: |
          # 上传 latest.yml 和 latest.json 到 OSS
          # 这样正式版用户能收到更新
```

**关键步骤**：
1. **触发条件**：推送 `v*` 标签
2. **构建打包**：`pnpm package`
3. **判断预发布**：通过 tag 名称判断是否为预发布版本
4. **更新 OSS**：只有正式版才更新 `latest.yml` 和 `latest.json`

## 15.7 OSS 分发

Molio 使用阿里云 OSS 分发 `latest.yml` 和 `latest.json`：

```yaml
# latest.yml
version: 0.3.22
files:
  - url: Molio-Setup-0.3.22.exe
    sha512: ...
    size: 123456789
path: Molio-Setup-0.3.22.exe
sha512: ...
releaseDate: '2024-06-20T12:00:00.000Z'
```

```json
// latest.json
{
  "version": "0.3.22",
  "files": [...],
  "releaseDate": "2024-06-20T12:00:00.000Z"
}
```

**更新检查流程**：
1. **electron-updater** 请求 `https://oss.example.com/latest.yml`
2. **比较版本**：当前版本 vs `latest.yml` 中的版本
3. **发现更新**：下载 `Molio-Setup-0.3.22.exe`
4. **验证签名**：校验 SHA512
5. **安装更新**：运行安装程序

**优势**：
- **CDN 加速**：OSS 提供全球 CDN
- **增量更新**：electron-updater 支持 NSIS 增量更新
- **版本控制**：通过 `latest.yml` 控制用户收到的版本

## 15.8 发版流程

### 15.8.1 内部测试

```bash
# 1. 推送 beta 标签
git tag v0.3.22-beta.1
git push origin v0.3.22-beta.1

# 2. GitHub Actions 自动构建
# 3. 发布到 GitHub Releases (pre-release)
# 4. beta 用户收到更新
```

### 15.8.2 正式发布

```bash
# 1. 推送正式版标签
git tag v0.3.22
git push origin v0.3.22

# 2. GitHub Actions 自动构建
# 3. 发布到 GitHub Releases (release)
# 4. 更新 OSS latest.yml / latest.json
# 5. 所有正式版用户收到更新
```

## 15.9 回滚策略

如果新版本有问题，可以通过以下方式回滚：

1. **删除 GitHub Release**：删除有问题的版本
2. **重新发布旧版本**：推送旧版本标签（如 `v0.3.21`）
3. **更新 OSS**：将 `latest.yml` 指向旧版本

**注意**：electron-updater 不会自动降级，用户需要手动安装旧版本。

## 15.10 更新日志

electron-updater 支持 release notes：

```javascript
autoUpdater.on('update-available', (info) => {
  // info.releaseNotes 包含 Markdown 格式的更新日志
  mainWindow.webContents.send('update-available', {
    version: info.version,
    releaseNotes: info.releaseNotes,
  });
});
```

**前端展示**：

```typescript
<dialog open={showUpdateDialog}>
  <h2>新版本 {updateInfo.version}</h2>
  <div className="release-notes">
    <MarkdownRenderer content={updateInfo.releaseNotes} />
  </div>
  <button onClick={handleDownload}>下载更新</button>
</dialog>
```

## 15.11 错误处理

```javascript
autoUpdater.on('error', (err) => {
  log('error', 'updater', `Updater error: ${err.message}`);
  
  // 网络错误：不提示用户，下次启动时重试
  if (err.message.includes('net::')) {
    return;
  }
  
  // 其他错误：提示用户
  const mainWindow = getMainWindow();
  if (mainWindow) {
    mainWindow.webContents.send('update-error', {
      message: err.message,
    });
  }
});
```

**错误分类**：
- **网络错误**：不提示用户，下次启动时重试
- **签名验证失败**：提示用户，阻止安装
- **其他错误**：记录日志，提示用户

## 15.12 配置选项

```javascript
// electron-updater 配置
autoUpdater.channel = 'latest'; // 更新通道：latest / beta / alpha
autoUpdater.allowDowngrade = false; // 不允许降级
autoUpdater.allowPrerelease = false; // 正式版用户不接收预发布
```

**更新通道**：
- **latest**：正式版
- **beta**：Beta 版本
- **alpha**：Alpha 版本

## 15.13 开发模式测试

```bash
# 设置环境变量，使用本地更新服务器
export USE_HARD_LINKS=false
export ELECTRON_UPDATER_DEBUG=true

# 启动开发模式
pnpm dev:desktop
```

**调试日志**：

```javascript
// 启用详细日志
autoUpdater.logger = {
  info: (msg) => console.log('[updater]', msg),
  warn: (msg) => console.warn('[updater]', msg),
  error: (msg) => console.error('[updater]', msg),
  debug: (msg) => console.debug('[updater]', msg),
};
```

## 小结

- **语义化版本**：正式版、Beta、RC 三种类型
- **预发布规则**：正式版用户只收正式版，预发布用户收同系列后续
- **更新流程**：检查 → 下载 → 验证 → 安装
- **OSS 分发**：通过 `latest.yml` 控制用户收到的版本
- **发版流程**：先推 beta 标签测试，再推正式版标签发布
- **回滚策略**：删除 Release，重新发布旧版本
- **错误处理**：网络错误静默重试，其他错误提示用户
- **开发测试**：环境变量启用调试模式
