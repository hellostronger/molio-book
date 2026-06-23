# 第 7 章 Runtime Registry：多 Agent 运行时的统一抽象

> Molio 支持 Claude Code、Codex、Gemini、Qwen 四大 AI 运行时，但 RunManager 的代码中看不到任何 `if (agent === 'claude')` 的分支。这是如何做到的？答案是 Runtime Registry：一个基于策略模式的注册表，将每个运行时的差异封装在独立的定义对象中。本章将拆解这个优雅的抽象层。

## 7.1 问题：多运行时的差异

四大 AI 运行时在以下方面存在差异：

| 维度 | Claude Code | Codex | Gemini | Qwen |
|------|-------------|-------|--------|------|
| **CLI 命令** | `claude` | `codex` | `gemini` | `qwen` |
| **参数格式** | `-p --input-format stream-json` | `--model` | `--model` | 类似 Claude |
| **输出格式** | `stream-json` (JSONL) | JSON event stream | JSON event stream | 类 Claude |
| **多轮对话** | stdin 保持开启 | 关闭 stdin | 关闭 stdin | 关闭 stdin |
| **环境变量** | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GEMINI_API_KEY` | `DASHSCOPE_API_KEY` |
| **安装方式** | npm native binary | npm 全局安装 | npm 全局安装 | npm 全局安装 |

如果这些差异散落在 RunManager 中，代码会变成：

```typescript
// 反模式：不要这样做
if (agentId === 'claude') {
  args = ['-p', '--input-format', 'stream-json', ...];
  parser = createClaudeStreamHandler();
} else if (agentId === 'codex') {
  args = ['--model', model, ...];
  parser = createCodexStreamHandler();
} else if (agentId === 'gemini') {
  // ...
}
```

## 7.2 解决方案：RuntimeAgentDef

Molio 的解决方案是定义一个统一的接口 `RuntimeAgentDef`，每个运行时实现一个对象：

```typescript
// packages/contracts/src/agent.ts (简化)
interface RuntimeAgentDef {
  id: string;                    // 唯一标识
  name: string;                  // 显示名称
  bin: string;                   // CLI 命令名
  fallbackBins?: string[];       // 备用命令名
  versionArgs: string[];         // 版本探测参数
  buildArgs: (prompt, options, context) => string[]; // 构造启动参数
  streamFormat: string;          // 输出流格式
  promptViaStdin?: boolean;      // 是否通过 stdin 发送 prompt
  promptInputFormat?: 'text' | 'stream-json';
  multiTurn?: boolean;           // 是否支持多轮对话
  fallbackModels: RuntimeModelOption[];
  install?: InstallConfig;       // 一键安装配置
}
```

## 7.3 注册表：registry.ts

`registry.ts` 是所有运行时定义的注册中心：

```typescript
// apps/daemon/src/core/runtimes/registry.ts
import { claudeAgentDef } from './claude.js';
import { codexAgentDef } from './codex.js';
import { geminiAgentDef } from './gemini.js';
import { qwenAgentDef } from './qwen.js';

const AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  codexAgentDef,
  geminiAgentDef,
  qwenAgentDef,
];

// 启动时检查重复 ID
const ids = new Set<string>();
for (const def of AGENT_DEFS) {
  if (ids.has(def.id)) throw new Error(`Duplicate agent def: ${def.id}`);
  ids.add(def.id);
}

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((d) => d.id === id) ?? null;
}

export function listAgentDefs(): RuntimeAgentDef[] {
  return AGENT_DEFS;
}
```

**设计洞察**：
- **启动时检查**：重复 ID 在启动时就报错，而非运行时
- **纯数据 + 函数**：`RuntimeAgentDef` 不包含状态，只有 `buildArgs` 一个方法
- **扩展性**：新增运行时只需创建新文件并添加到 `AGENT_DEFS`

## 7.4 Claude Code 定义：完整示例

```typescript
// apps/daemon/src/core/runtimes/claude.ts
export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],
  versionArgs: ['--version'],

  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
    { id: 'haiku', label: 'Haiku (alias)' },
    { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
  ],

  buildArgs: (_prompt, options = {}) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    args.push('--dangerously-skip-permissions');
    return args;
  },

  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  multiTurn: true,

  install: {
    source: {
      type: 'npm-native',
      version: '2.1.179',
      packages: {
        'win32-x64':        { pkgName: '@anthropic-ai/claude-code-win32-x64',       binInTar: 'package/claude.exe' },
        'darwin-arm64':     { pkgName: '@anthropic-ai/claude-code-darwin-arm64',    binInTar: 'package/claude' },
        // ... 其他平台
      },
      registries: [
        'https://registry.npmjs.org',
        'https://registry.npmmirror.com',
      ],
    },
    requirements: {
      minWindowsBuild: 17763, // Windows 10 1809
    },
  },
  installUrl: 'https://code.claude.com/docs/en/setup',
};
```

**关键点**：
- `multiTurn: true`：告诉 RunManager 保持 stdin 开启
- `promptInputFormat: 'stream-json'`：使用 JSON 格式发送 prompt
- `install.source`：一键安装配置，支持多平台、多 registry
- `buildArgs`：返回命令行参数数组，不关心 prompt 内容（因为通过 stdin 发送）

## 7.5 二进制探测：launch.ts

`resolveAgentBinary` 负责找到运行时的可执行文件：

```typescript
// apps/daemon/src/core/runtimes/launch.ts (简化)
export function resolveAgentBinary(
  def: RuntimeAgentDef,
  opts: { configuredEnv: Record<string, string> },
): { binary: string | null; source: AgentDetectSource } {
  // 1. 环境变量覆盖（最高优先级）
  const envBin = opts.configuredEnv[`${def.id.toUpperCase()}_BIN`];
  if (envBin && existsSync(envBin)) {
    return { binary: envBin, source: 'env-override' };
  }

  // 2. PATH 中查找
  const whichResult = whichSync(def.bin);
  if (whichResult) {
    return { binary: whichResult, source: 'path' };
  }

  // 3. 备用命令名
  if (def.fallbackBins) {
    for (const fallback of def.fallbackBins) {
      const result = whichSync(fallback);
      if (result) return { binary: result, source: 'fallback-bin' };
    }
  }

  // 4. 知名路径（Windows 下的 npm 全局安装目录）
  const wellKnown = findInWellKnownPaths(def.bin);
  if (wellKnown) {
    return { binary: wellKnown, source: 'well-known' };
  }

  return { binary: null, source: 'not-found' };
}
```

**探测顺序**：
1. **环境变量**：用户显式指定的路径
2. **PATH**：系统 PATH 中的命令
3. **备用命令名**：如 `openclaude` 是 `claude` 的备用
4. **知名路径**：npm 全局安装目录等

## 7.6 版本探测

`probeVersion` 通过执行 `binary --version` 获取版本号：

```typescript
// apps/daemon/src/core/runtimes/launch.ts (简化)
export function probeVersion(binary: string, versionArgs: string[]): {
  version: string | null;
  error: string | null;
} {
  try {
    const result = execSync(`${binary} ${versionArgs.join(' ')}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 提取版本号 (如 "2.1.179" 从 "claude 2.1.179")
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return { version: match?.[1] ?? null, error: null };
  } catch (err) {
    return { version: null, error: err.message };
  }
}
```

**关键设计**：
- **5 秒超时**：避免卡住启动
- **二进制存在但无法执行**：标记为 `available: false`（处理损坏的安装）

## 7.7 一键安装引擎

`install.ts` 实现了自动安装运行时的能力。以 Claude Code 为例：

```typescript
// apps/daemon/src/core/runtimes/install.ts (简化)
export async function installAgent(
  def: RuntimeAgentDef,
  onEvent: (ev: InstallEvent) => void,
): Promise<void> {
  if (!def.install) throw new Error('Agent not installable');

  const source = def.install.source;
  if (source.type !== 'npm-native') throw new Error('Unsupported install source');

  // 1. 预检查
  onEvent({ type: 'phase', phase: 'preflight', message: 'Checking platform compatibility...' });
  if (def.install.requirements?.minWindowsBuild) {
    const build = getWindowsBuildNumber();
    if (build < def.install.requirements.minWindowsBuild) {
      throw new Error(`Windows build ${build} < required ${def.install.requirements.minWindowsBuild}`);
    }
  }

  // 2. 下载
  onEvent({ type: 'phase', phase: 'download', message: 'Downloading...' });
  const platformKey = getPlatformKey(); // 'win32-x64', 'darwin-arm64', etc.
  const pkg = source.packages[platformKey];
  if (!pkg) throw new Error(`No package for platform ${platformKey}`);

  // 尝试多个 registry
  let tarball: Buffer | null = null;
  for (const registry of source.registries) {
    try {
      tarball = await downloadNpmPackage(pkg.pkgName, source.version, registry);
      break;
    } catch {
      continue; // 尝试下一个 registry
    }
  }
  if (!tarball) throw new Error('Failed to download from all registries');

  // 3. 解压
  onEvent({ type: 'phase', phase: 'extract', message: 'Extracting...' });
  const binaryPath = extractBinaryFromTarball(tarball, pkg.binInTar);

  // 4. 验证
  onEvent({ type: 'phase', phase: 'validate', message: 'Validating...' });
  chmod(binaryPath, 0o755);
  const probe = probeVersion(binaryPath, def.versionArgs);
  if (!probe.version) throw new Error('Installed binary is not executable');

  // 5. 测试
  onEvent({ type: 'phase', phase: 'test', message: 'Testing...' });
  // 实际运行一次，确保能正常启动

  // 6. 添加到 PATH
  onEvent({ type: 'phase', phase: 'path', message: 'Adding to PATH...' });
  addToMolioPath(binaryPath);

  onEvent({ type: 'done', message: 'Installation complete', binaryPath, version: probe.version });
}
```

**安装流程**：
1. **Preflight**：检查平台兼容性
2. **Download**：从 npm registry 下载 tarball
3. **Extract**：从 tarball 中提取二进制文件
4. **Validate**：验证二进制可执行
5. **Test**：实际运行测试
6. **Path**：添加到 Molio 的 PATH

**多 Registry 容错**：先尝试 npmjs.org，失败后尝试 npmmirror.com（中国镜像）。

## 7.8 环境变量构建

`env.ts` 负责构建 spawn 时的环境变量：

```typescript
// apps/daemon/src/core/runtimes/env.ts (简化)
export function buildSpawnEnv(
  def: RuntimeAgentDef,
  mergedEnv: Record<string, string>,
): Record<string, string> {
  const env = { ...process.env, ...mergedEnv };

  // 禁用交互式提示
  env['CI'] = 'true';
  env['NO_COLOR'] = '1';

  // 特定运行时的环境变量
  if (def.id === 'claude') {
    env['CLAUDE_CODE_DISABLE_NOTIFICATIONS'] = '1';
  }

  return env;
}
```

## 7.9 扩展新运行时

添加一个新的 AI 运行时只需要三步：

1. **创建定义文件**：`apps/daemon/src/core/runtimes/newagent.ts`
2. **实现 RuntimeAgentDef**：填充所有必填字段
3. **注册**：在 `registry.ts` 中添加到 `AGENT_DEFS`

```typescript
// apps/daemon/src/core/runtimes/newagent.ts
export const newAgentDef: RuntimeAgentDef = {
  id: 'newagent',
  name: 'New Agent',
  bin: 'newagent',
  versionArgs: ['--version'],
  buildArgs: (prompt, options) => ['--prompt', prompt],
  streamFormat: 'json-event-stream',
  promptViaStdin: false,
  fallbackModels: [{ id: 'default', label: 'Default' }],
};

// apps/daemon/src/core/runtimes/registry.ts
import { newAgentDef } from './newagent.js';
const AGENT_DEFS = [..., newAgentDef];
```

**无需修改 RunManager**：策略模式的优势在于，新增策略不影响上下文。

## 小结

- **RuntimeAgentDef 是策略模式**：将运行时差异封装在独立对象中
- **注册表是单一真相来源**：所有运行时定义集中管理
- **二进制探测多级回退**：环境变量 → PATH → 备用命令 → 知名路径
- **一键安装引擎**：支持多平台、多 registry、完整的安装流程
- **扩展性**：新增运行时只需实现接口并注册，无需修改 RunManager
- **版本探测**：5 秒超时，检测损坏的安装
