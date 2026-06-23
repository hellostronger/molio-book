# 第 6 章 Stream Parser：将混沌输出变为结构化事件

> AI Agent CLI 的 stdout 输出是混沌的：可能是 JSONL、可能是 ANSI 转义序列、可能是多个 Agent 各自不同的格式。Stream Parser 层的作用是将这些混沌输出解析为统一的 `AgentEvent`。本章将深入拆解四种解析器的实现细节。

## 6.1 为什么需要 Stream Parser？

不同 AI 运行时的输出格式差异巨大：

| 运行时 | 输出格式 | 特点 |
|--------|---------|------|
| Claude Code | `stream-json` (JSONL) | 每行一个 JSON，包含 stream_event、assistant、result |
| Codex | JSON event stream | 不同的 JSON 结构 |
| Gemini | JSON event stream | 又一种 JSON 结构 |
| Qwen | 类 Claude 格式 | 部分兼容 Claude stream-json |

如果让 RunManager 直接处理这些差异，代码会变成一坨 `if-else` 地狱。Stream Parser 层通过**策略模式**将差异封装在独立的解析器中：

```
stdout chunk → StreamHandler.feed(chunk) → AgentEvent
                    ↑
            具体实现由 selectParser() 选择
```

## 6.2 StreamHandler 接口

```typescript
// packages/contracts/src/event.ts
interface StreamHandler {
  feed(chunk: string | Buffer): void;  // 接收数据块
  flush(): void;                        // 进程结束时调用
}
```

接口极其简单：`feed` 接收数据块，内部解析后通过回调发出 `AgentEvent`。`flush` 用于处理缓冲区中残留的不完整行。

## 6.3 JSONL 解析器：行缓冲

所有 JSON 格式的解析器都基于 `createJsonlParser`，它负责将字节流分割为完整的 JSON 行：

```typescript
// apps/daemon/src/core/streams/jsonl-parser.ts (简化)
export function createJsonlParser(onLine: (line: string) => void): StreamHandler {
  let buffer = '';

  return {
    feed(chunk: string | Buffer) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 最后一行可能不完整，保留在 buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    },
    flush() {
      const trimmed = buffer.trim();
      if (trimmed) onLine(trimmed);
      buffer = '';
    },
  };
}
```

**关键细节**：
- 字节流可能在一个 JSON 的中间被截断（TCP/pipe 的分包特性）
- `buffer.split('\n')` 后，最后一个元素是不完整的行，需要保留
- `flush` 在进程结束时调用，处理最后一行

## 6.4 Claude Stream 解析器：最复杂的解析器

Claude Code 的 `stream-json` 格式是最复杂的，`claude-stream.ts` 有 200 行代码。它的输出结构：

```json
{"type":"system","subtype":"init","model":"claude-opus-4-5"}
{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_xxx"},"ttft_ms":123}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"assistant","message":{"id":"msg_xxx","content":[{"type":"text","text":"Hello, world!"}]}}
{"type":"result","usage":{...},"total_cost_usd":0.01,"duration_ms":1234}
```

### 6.4.1 状态管理

解析器需要维护几个状态：

```typescript
const blocks = new Map<string, BlockState>();  // 正在流式传输的 content block
const streamedToolUseIds = new Set<string>();   // 已经通过 stream 发出的 tool_use
const textStreamed = new Set<string>();         // 已经通过 stream 发出的 text message
const thinkingStreamed = new Set<string>();     // 已经通过 stream 发出的 thinking
let currentMessageId: string | null = null;
```

**为什么需要去重？**

Claude Code 的输出有两套机制：
1. **stream_event**：增量事件（content_block_delta），实时流式
2. **assistant**：完整消息（在 stream 结束后发出），包含完整内容

如果不做去重，前端会收到两次相同的文本。解析器通过 `textStreamed`、`thinkingStreamed`、`streamedToolUseIds` 三个 Set 追踪哪些内容已经通过 stream_event 发出，当 assistant 消息到达时跳过已发出的内容。

### 6.4.2 处理 stream_event

```typescript
function handleStreamEvent(ev: Record<string, unknown>): void {
  // message_start: 新消息开始
  if (ev['type'] === 'message_start') {
    currentMessageId = msg['id'];
    if (ev['ttft_ms']) {
      onEvent({ type: 'status', label: 'streaming', ttftMs: ev['ttft_ms'] });
    }
    return;
  }

  // content_block_start: 新的内容块
  if (ev['type'] === 'content_block_start') {
    blocks.set(blockKey(ev['index']), {
      type: block['type'],
      name: block['name'],
      id: block['id'],
      input: '',
    });
    if (block['type'] === 'thinking') {
      onEvent({ type: 'thinking_start' });
    }
    return;
  }

  // content_block_delta: 增量内容
  if (ev['type'] === 'content_block_delta') {
    const delta = ev['delta'];
    const state = blocks.get(blockKey(ev['index']));

    if (delta['type'] === 'text_delta') {
      textStreamed.add(currentMessageId);
      onEvent({ type: 'text_delta', delta: delta['text'] });
    }
    if (delta['type'] === 'thinking_delta') {
      thinkingStreamed.add(currentMessageId);
      onEvent({ type: 'thinking_delta', delta: delta['thinking'] });
    }
    if (delta['type'] === 'input_json_delta') {
      // tool_use 的参数是增量 JSON，需要累积
      state.input += delta['partial_json'];
    }
    return;
  }

  // content_block_stop: 内容块结束
  if (ev['type'] === 'content_block_stop') {
    const state = blocks.get(blockKey(ev['index']));
    if (state?.type === 'tool_use' && state.id) {
      // 累积完成后，解析 JSON 并发出 tool_use 事件
      onEvent({
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: JSON.parse(state.input),
      });
      streamedToolUseIds.add(state.id); // 标记为已发出
    }
    blocks.delete(blockKey(ev['index']));
    return;
  }
}
```

### 6.4.3 处理 assistant 和 result

```typescript
// assistant 消息: 完整内容，需要去重
if (obj['type'] === 'assistant') {
  const msg = obj['message'];
  for (const block of msg['content']) {
    if (block['type'] === 'tool_use') {
      if (!streamedToolUseIds.has(block['id'])) {
        // 未通过 stream 发出的 tool_use（可能是非流式模式）
        onEvent({ type: 'tool_use', id: block['id'], name: block['name'], input: block['input'] });
      } else {
        streamedToolUseIds.delete(block['id']); // 清理
      }
    } else if (block['type'] === 'text') {
      if (!textStreamed.has(msgId)) {
        // 未通过 stream 发出的文本
        onEvent({ type: 'text_delta', delta: block['text'] });
      }
    }
  }
  return;
}

// result 消息: turn 结束信号
if (obj['type'] === 'result') {
  if (obj['is_error']) {
    onEvent({ type: 'error', message: obj['error']['message'] });
    return;
  }
  // 无条件发出 turn_end — 即使 assistant 块也发过，也是安全的
  // 因为所有下游消费者（RunManager.flush、前端 streaming=false）都是幂等的
  onEvent({ type: 'turn_end', stopReason: 'end_turn' });
  onEvent({ type: 'usage', usage: obj['usage'], costUsd: obj['total_cost_usd'], durationMs: obj['duration_ms'] });
  return;
}
```

**为什么要无条件发出 turn_end？**

注释中解释了原因：Claude Code 的 assistant 块中 `stop_reason` 永远是 `null`（至少在 2.1.168 版本），所以 `turn_end` 只能从 `result` 事件发出。如果不这样做，最后一轮回复永远不会被刷新到数据库（issue #87）。

## 6.5 Codex Stream 解析器

Codex 的输出格式不同，但解析器结构类似：

```typescript
// apps/daemon/src/core/streams/codex-stream.ts (简化)
export function createCodexStreamHandler(onEvent): StreamHandler {
  return createJsonlParser((line) => {
    const obj = JSON.parse(line);
    
    // Codex 的 item 类型
    if (obj.type === 'item.completed') {
      const item = obj.item;
      if (item.type === 'message') {
        // 助手消息
        for (const content of item.content) {
          if (content.type === 'output_text') {
            onEvent({ type: 'text_delta', delta: content.text });
          }
        }
      }
    }
    
    // 工具调用
    if (obj.type === 'response.completed') {
      onEvent({ type: 'turn_end', stopReason: 'end_turn' });
    }
  });
}
```

## 6.6 JSON Event Stream：通用分发器

对于使用标准 JSON 事件流的 Agent（Gemini、Qwen 等），Molio 实现了一个通用分发器：

```typescript
// apps/daemon/src/core/streams/json-event-stream.ts (简化)
export function createJsonEventStreamHandler(
  parserType: string,
  onEvent: (ev: AgentEvent) => void,
): StreamHandler {
  // 根据 parserType 选择具体的解析逻辑
  // 支持 'unknown' 作为回退
  
  return createJsonlParser((line) => {
    const obj = JSON.parse(line);
    // 通用的事件映射逻辑
    // 将不同 Agent 的事件格式转换为统一的 AgentEvent
  });
}
```

## 6.7 选择解析器

RunManager 通过 `selectParser` 方法选择合适的解析器：

```typescript
private selectParser(def: RuntimeAgentDef, onEvent: (ev: AgentEvent) => void): StreamHandler {
  if (def.streamFormat === 'claude-stream-json') {
    return createClaudeStreamHandler(onEvent);
  }
  if (def.streamFormat === 'json-event-stream') {
    return createJsonEventStreamHandler(def.eventParser ?? 'unknown', onEvent);
  }
  // 纯文本或无法识别的格式 — 透传为 raw 事件
  return createJsonlParser((line) => {
    onEvent({ type: 'raw', line });
  });
}
```

这是**策略模式**的典型应用：RunManager 不关心具体解析逻辑，只依赖 `StreamHandler` 接口。

## 6.8 解析器的错误容忍

解析器对错误有极强的容忍度：

```typescript
// JSON 解析失败时，发出 raw 事件而非抛错
return createJsonlParser((line) => {
  try {
    handleObject(JSON.parse(line));
  } catch {
    onEvent({ type: 'raw', line });
  }
});
```

**为什么这样设计？**

- Agent CLI 可能输出非 JSON 的调试信息
- 网络抖动可能导致不完整的 JSON
- `raw` 事件保证信息不丢失，前端可以选择显示或忽略

## 6.9 性能考量

解析器的性能瓶颈在于 JSON.parse。对于高频的 `text_delta` 事件，每次都要解析一个完整的 JSON 对象。优化手段：

1. **行缓冲**：只在 `\n` 处分割，避免不完整的 JSON
2. **Map 查找**：`blocks` 使用 Map，O(1) 查找
3. **Set 去重**：`textStreamed` 使用 Set，O(1) 查找
4. **最小化对象创建**：只在必要时创建 `AgentEvent` 对象

## 小结

- **Stream Parser 层封装了格式差异**：RunManager 只依赖 `StreamHandler` 接口
- **JSONL 解析器是基础**：处理字节流到行的分割，缓冲不完整的行
- **Claude 解析器最复杂**：需要处理 stream_event + assistant 双重机制，通过 Set 去重
- **turn_end 的无条件发出**：解决了 Claude Code 2.1.168 的 stop_reason 永远为 null 的问题
- **错误容忍**：解析失败回退为 `raw` 事件，保证信息不丢失
- **策略模式**：`selectParser` 根据 `streamFormat` 选择合适的解析器
