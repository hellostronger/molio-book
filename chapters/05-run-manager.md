# 第 5 章 RunManager：AI Agent 编排的核心引擎

> RunManager 是 Molio 的心脏。它管理 AI Agent 进程的完整生命周期：从二进制探测、子进程 spawn、流式事件解析、多轮对话、到取消与清理。本章将逐行拆解它的 580 行源码，揭示它是如何用单一类掌控全局的。

## 5.1 为什么需要 RunManager？

想象一下没有 RunManager 的世界：前端要直接 spawn 子进程，管理 stdin/stdout，解析不同格式的流，缓冲事件，处理 SSE 订阅，还要在多轮对话中保持 stdin 开启。这些职责一旦散落在各处，系统会变得脆弱且难以测试。

RunManager 的核心价值在于**集中化编排**：

```
┌─────────────────────────────────────────────────────────┐
│                     RunManager                          │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Claude Code │  │  OpenAI     │  │  Gemini     │    │
│  │  (child)    │  │  Codex      │  │  CLI        │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │            │
│         └────────┬───────┴────────────────┘            │
│                  ↓                                      │
│           AgentEvent 流                                 │
│                  ↓                                      │
│        ┌─────────────────┐                              │
│        │  事件缓冲 + SSE │                              │
│        └─────────────────┘                              │
└─────────────────────────────────────────────────────────┘
```

## 5.2 核心状态：RunState

每个活跃的 run 对应一个 `RunState` 对象：

```typescript
// apps/daemon/types.ts (简化)
interface RunState {
  id: string;
  agentId: string;
  status: RunStatus;           // 'running' | 'succeeded' | 'failed' | 'canceled'
  child: ChildProcess | null;
  stdinOpen: boolean;          // stdin 是否保持开启（多轮对话）
  pendingHostAnswers: Set<string>; // 等待用户回答的 tool_use ID
  lastStopReason: string | null;
  
  // 事件系统
  eventListeners: Set<(ev: AgentEvent) => void>;
  events: BufferedEvent[];     // 内存中的事件缓冲
  nextEventId: number;         // 下一个事件序号
  
  // 持久化
  eventsLogPath: string;       // JSONL 日志路径
  eventsLogStream: WriteStream | null;
  
  // 文本累积
  turnText: TurnTextCollector; // 将 text_delta 累积为完整回复
  
  // 上下文
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  error: string | null;
}
```

**关键设计**：
- `events` 数组在内存中限制 2000 条（`MAX_EVENTS`），超过后丢弃最早的
- `eventsLogStream` 将事件异步写入 JSONL 文件，用于事后分析
- `pendingHostAnswers` 追踪等待用户输入的工具调用，防止过早关闭 stdin

## 5.3 创建 Run：从请求到进程

`createRun()` 是 RunManager 最复杂的方法，它完成以下步骤：

```typescript
// apps/daemon/src/core/RunManager.ts (简化)
async createRun(opts: CreateRunOptions): Promise<string> {
  // 1. 解析运行时定义
  const def = getAgentDef(opts.agentId);
  if (!def) throw new Error(`Unknown agent: ${opts.agentId}`);

  // 2. 解析二进制路径
  const result = resolveAgentBinary(def, { configuredEnv });
  if (!result.binary) {
    throw new Error(`Binary not found for ${def.name}`);
  }

  // 3. 初始化 RunState
  const runId = randomUUID();
  const run: RunState = {
    id: runId,
    agentId: opts.agentId,
    status: 'running',
    child: null,
    stdinOpen: false,
    pendingHostAnswers: new Set(),
    // ... 其他字段
    turnText: new TurnTextCollector(runId, opts.onTurnComplete),
  };
  this.runs.set(runId, run);

  // 4. 构建环境变量和参数
  const env = buildSpawnEnv(def, mergedEnv);
  env['MOLIO_RUN_ID'] = runId;
  const args = def.buildArgs(opts.message, { model: opts.model }, { cwd: opts.cwd });

  // 5. spawn 子进程
  const child = spawn(result.binary, args, {
    env,
    stdio: [stdinMode, 'pipe', 'pipe'],
    cwd: opts.cwd || agentConfig.env?.['MOLIO_CWD'] || process.cwd(),
    shell: isCmd, // Windows 下 .cmd 文件需要 shell: true
  });
  run.child = child;

  // 6. 发送 prompt
  if (def.promptViaStdin && child.stdin) {
    const prompt = this.composePrompt(runtimeHint + opts.message, opts.history);
    if (def.promptInputFormat === 'stream-json') {
      // Claude Code: stream-json 格式，stdin 保持开启
      const msg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
      });
      child.stdin.write(msg + '\n', 'utf8');
      run.stdinOpen = true;
    } else {
      // 其他 Agent: 文本格式，关闭 stdin
      child.stdin.end(prompt);
    }
  }

  // 7. 选择流解析器
  const parser = this.selectParser(def, (ev) => {
    this.emitEvent(run, ev);
    // 处理特殊事件
    if (ev.type === 'tool_use' && ev.name === 'AskUserQuestion') {
      run.pendingHostAnswers.add(ev.id);
    }
    if (ev.type === 'turn_end') {
      run.lastStopReason = ev.stopReason;
      this.maybeCloseStdin(run);
    }
  });

  // 8. 连接 stdout → parser
  child.stdout?.on('data', (chunk) => parser.feed(chunk));

  // 9. 处理 stderr
  child.stderr?.on('data', (chunk) => {
    const text = stderrDecoder(chunk);
    if (text.trim() && !isCodexInfoStderr(text)) {
      this.emitEvent(run, { type: 'error', message: text });
    }
  });

  // 10. 处理进程退出
  child.on('close', (code) => {
    parser.flush();
    this.finishRun(run, code === 0 ? 'succeeded' : 'failed', code, null);
  });

  return runId;
}
```

**关键决策**：

1. **spawn 而非 exec**：`child_process.spawn` 是流式的，适合长时间运行的 Agent；`exec` 会缓冲所有输出。
2. **Windows 兼容性**：`.cmd` 和 `.bat` 文件需要 `shell: true`，否则会报 `EINVAL`。
3. **多轮 vs 单轮**：`stream-json` 格式的 Agent（如 Claude Code）保持 stdin 开启；其他 Agent 发送 prompt 后立即关闭。

## 5.4 事件系统：emitEvent

`emitEvent` 是 RunManager 的内部方法，负责将事件分发到三个目标：

```typescript
private emitEvent(run: RunState, event: AgentEvent): void {
  // 1. 累积文本（用于持久化）
  if (event.type === 'text_delta') {
    run.turnText.append(event.delta);
  }

  // 2. 在 turn 结束时刷新文本（写入 SQLite）
  if (event.type === 'turn_end' && event.stopReason !== 'tool_use') {
    run.turnText.flush();
  }

  // 3. 缓冲事件（内存中保留最近 2000 条）
  const id = run.nextEventId++;
  const record: BufferedEvent = { id, event: event.type, data: event, timestamp: Date.now() };
  run.events.push(record);
  if (run.events.length > MAX_EVENTS) {
    run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  // 4. 写入 JSONL 日志（异步，best-effort）
  this.ensureLogStream(run)?.write(JSON.stringify(record) + '\n');

  // 5. 扇出到所有监听器（SSE 订阅者）
  for (const listener of run.eventListeners) {
    try { listener(event); } catch { /* 跳过出错的监听器 */ }
  }
}
```

**设计洞察**：

- **缓冲限制**：2000 条事件约 1-2MB 内存，防止长时间运行的 Agent 占用过多内存
- **JSONL 日志**：即使 daemon 崩溃，事件也不会丢失（写入磁盘）
- **监听器隔离**：一个监听器抛错不影响其他监听器

## 5.5 多轮对话：stdin 生命周期

多轮对话是 Molio 的核心特性之一。RunManager 通过精细管理 stdin 的生命周期来实现：

```typescript
// 发送后续消息
sendMessage(runId: string, message: string): void {
  const run = this.runs.get(runId);
  if (!run.child?.stdin?.writable || !run.stdinOpen) {
    throw new Error('Run not active or stdin closed');
  }
  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });
  run.child.stdin.write(msg + '\n', 'utf8');
}

// 提交工具结果
submitToolResult(runId: string, toolUseId: string, content: string): void {
  const run = this.runs.get(runId);
  const msg = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: false }],
    },
  });
  run.child.stdin.write(msg + '\n', 'utf8');
  run.pendingHostAnswers.delete(toolUseId);
  this.maybeCloseStdin(run);
}

// 决定是否关闭 stdin
private maybeCloseStdin(run: RunState): void {
  // 如果还有待回答的问题，不关闭
  if (run.pendingHostAnswers.size > 0) return;
  // 如果 Agent 在等待工具结果，不关闭
  if (run.lastStopReason === 'tool_use') return;
  // 多轮 Agent 保持 stdin 开启
  const def = getAgentDef(run.agentId);
  if (def?.multiTurn) return;
  // 其他情况关闭 stdin
  if (run.child?.stdin?.writable && run.stdinOpen) {
    run.child.stdin.end();
    run.stdinOpen = false;
  }
}
```

**状态机**：

```
[spawn] → stdin 开启
   ↓
[turn_end, stopReason=end_turn] → 单轮: 关闭 stdin; 多轮: 保持开启
   ↓
[sendMessage] → 写入 stdin, 等待下一个 turn
   ↓
[tool_use: AskUserQuestion] → pendingHostAnswers.add(id)
   ↓
[submitToolResult] → pendingHostAnswers.delete(id), maybeCloseStdin
   ↓
[cancelRun 或 进程退出] → stdin 强制关闭
```

## 5.6 TurnTextCollector：文本累积器

`TurnTextCollector` 负责将流式的 `text_delta` 累积为完整的回复文本，并在适当的时机调用 `onTurnComplete` 回调：

```typescript
// apps/daemon/src/core/turn-text-collector.ts (简化)
class TurnTextCollector {
  private buffer = '';
  
  append(delta: string): void {
    this.buffer += delta;
  }
  
  flush(): void {
    if (this.buffer && this.onComplete) {
      this.onComplete(this.buffer, this.runId);
    }
    this.buffer = '';
  }
}
```

**为什么需要它？**

Agent 的 stdout 输出是流式的（`text_delta`），但 SQLite 中的 `ChatMessage` 需要完整的 `content`。`TurnTextCollector` 在 `turn_end` 或 `status: completed/failed` 时刷新缓冲区，将完整文本写入数据库。

## 5.7 清理与 TTL

Run 完成后，RunManager 不会立即删除它，而是等待 30 分钟（`RUN_TTL_MS`）：

```typescript
private finishRun(run: RunState, status, code, signal): void {
  if (TERMINAL_STATUSES.has(run.status)) return; // 幂等

  run.status = status;
  run.exitCode = code;
  run.stdinOpen = false;

  // 发出结束事件
  this.emitEvent(run, { type: 'status', label: status === 'succeeded' ? 'completed' : status });

  // 关闭 JSONL 日志流
  run.eventsLogStream?.end();

  // 30 分钟后从内存中删除
  setTimeout(() => {
    if (TERMINAL_STATUSES.has(run.status)) {
      this.runs.delete(run.id);
    }
  }, RUN_TTL_MS).unref?.();
}
```

**为什么延迟删除？**

- 前端可能需要重连并获取历史事件
- 错误诊断需要保留最后的 run 状态
- `unref()` 确保定时器不会阻止进程退出

## 5.8 取消 Run

`cancelRun` 实现了优雅的取消逻辑：

```typescript
cancelRun(runId: string): void {
  const run = this.runs.get(runId);
  if (!run) return;

  // 先刷新待处理的文本
  run.turnText.flush();

  // 发送 SIGTERM，等待 5 秒后升级为 SIGKILL
  if (run.child && !run.child.killed) {
    run.child.kill('SIGTERM');
    setTimeout(() => {
      if (run.child && !run.child.killed) {
        run.child.kill('SIGKILL');
      }
    }, 5000);
  }

  // 关闭 stdin
  if (run.stdinOpen && run.child?.stdin?.writable) {
    run.child.stdin.end();
    run.stdinOpen = false;
  }
}
```

**两级杀进程策略**：先 SIGTERM 让进程有机会清理资源，5 秒后 SIGKILL 强制终止。这避免了 Agent 进程成为僵尸进程。

## 小结

- **RunManager 是编排核心**：集中管理 Agent 进程的生命周期、事件流、多轮对话
- **RunState 是状态容器**：缓冲事件、追踪 stdin 状态、累积文本
- **事件系统三路分发**：内存缓冲、JSONL 日志、SSE 监听器
- **多轮对话通过 stdin 管理**：`stream-json` 格式保持 stdin 开启，`pendingHostAnswers` 防止过早关闭
- **TTL 延迟清理**：30 分钟后从内存删除，支持重连和诊断
- **两级取消**：SIGTERM + 超时 SIGKILL，避免僵尸进程
