# 第 9 章 SSE 事件推送：实时数据流的端到端设计

> Server-Sent Events (SSE) 是 Molio 实时数据流的核心传输层。本章将拆解从 daemon 的 `createSSEStream` 到前端 `EventSource` 的完整链路，揭示它是如何实现事件重放、断线恢复、心跳保活的。

## 9.1 为什么选择 SSE 而非 WebSocket？

| 特性 | SSE | WebSocket |
|------|-----|-----------|
| **方向** | 单向（服务端 → 客户端） | 双向 |
| **协议** | HTTP | 独立协议 (ws://) |
| **自动重连** | 浏览器原生支持 | 需要手动实现 |
| **代理兼容** | 兼容所有 HTTP 代理 | 可能被代理拦截 |
| **复杂度** | 简单 | 复杂 |

Molio 的数据流是单向的：daemon → web。前端发送请求通过 HTTP POST，接收事件通过 SSE。这种设计简单且可靠。

## 9.2 SSE 传输层实现

`createSSEStream` 是 daemon 端的 SSE 实现：

```typescript
// apps/daemon/src/sse.ts
export function createSSEStream(
  runManager: RunManager,
  runId: string,
  afterId: number = 0,
): { stream: ReadableStream<Uint8Array>; cleanup: () => void } {
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 阶段 1: 重放缓冲事件 (id > afterId)
      const buffered = runManager.getBufferedEvents(runId, afterId);
      if (buffered) {
        for (const record of buffered) {
          const envelope = { seq: record.id, runId, event: record.data };
          const frame = `id: ${record.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }
      }

      // 阶段 2: 如果 run 已结束，关闭流
      if (runManager.isTerminal(runId)) {
        controller.close();
        return;
      }

      // 阶段 3: 订阅实时事件
      unsub = runManager.onEvent(runId, (event) => {
        const lastId = runManager.getLastEventId(runId);
        const envelope = { seq: lastId, runId, event };
        const frame = `id: ${lastId}\ndata: ${JSON.stringify(envelope)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      });

      // 阶段 4: 心跳保活 (15 秒一次)
      pingInterval = setInterval(() => {
        controller.enqueue(encoder.encode(':ping\n\n'));
      }, 15_000);
    },

    cancel() {
      unsub?.();
      unsub = null;
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    },
  });

  return {
    stream,
    cleanup: () => {
      unsub?.();
      if (pingInterval) clearInterval(pingInterval);
    },
  };
}
```

## 9.3 四阶段生命周期

SSE 流的生命周期分为四个阶段：

### 阶段 1: 事件重放

```typescript
const buffered = runManager.getBufferedEvents(runId, afterId);
if (buffered) {
  for (const record of buffered) {
    const envelope = { seq: record.id, runId, event: record.data };
    const frame = `id: ${record.id}\ndata: ${JSON.stringify(envelope)}\n\n`;
    controller.enqueue(encoder.encode(frame));
  }
}
```

**为什么需要重放？**

当客户端断线重连时，它可能错过了某些事件。通过 `afterId` 参数，服务端可以从缓冲区中重放缺失的事件。

**缓冲限制**：RunManager 在内存中保留最近 2000 条事件。如果缺失的事件超过 2000 条，客户端无法完全恢复，需要重新创建 run。

### 阶段 2: 终态检查

```typescript
if (runManager.isTerminal(runId)) {
  controller.close();
  return;
}
```

如果 run 已经结束（succeeded/failed/canceled），直接关闭流。客户端通过重放获取所有事件。

### 阶段 3: 实时订阅

```typescript
unsub = runManager.onEvent(runId, (event) => {
  const lastId = runManager.getLastEventId(runId);
  const envelope = { seq: lastId, runId, event };
  const frame = `id: ${lastId}\ndata: ${JSON.stringify(envelope)}\n\n`;
  controller.enqueue(encoder.encode(frame));
});
```

订阅 RunManager 的事件流，每个事件都包装在 `SSEEnvelope` 中发送。

### 阶段 4: 心跳保活

```typescript
pingInterval = setInterval(() => {
  controller.enqueue(encoder.encode(':ping\n\n'));
}, 15_000);
```

每 15 秒发送一次心跳（SSE 注释格式 `:ping`），防止代理或负载均衡器因为超时而关闭连接。

## 9.4 SSE 帧格式

SSE 的帧格式：

```
id: 42
data: {"seq":42,"runId":"abc-123","event":{"type":"text_delta","delta":"Hello"}}

```

- **id 字段**：事件序列号，用于断线重连
- **data 字段**：JSON 格式的 `SSEEnvelope`
- **空行**：帧分隔符

## 9.5 前端 EventSource

前端使用浏览器原生的 `EventSource` API：

```typescript
// apps/web/src/api/sse.ts
export function subscribeToRun(
  runId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Event) => void,
  onDone?: () => void,
): EventSource {
  const es = new EventSource(`/api/runs/${runId}/events`);

  es.onmessage = (msg) => {
    try {
      const envelope: SSEEnvelope = JSON.parse(msg.data);
      onEvent(envelope.event);
    } catch {
      // 忽略解析错误（如心跳注释）
    }
  };

  es.onerror = (err) => {
    onError?.(err);
    // EventSource 默认会自动重连
  };

  return es;
}
```

**自动重连**：`EventSource` 在连接断开时会自动重连。重连时会带上 `Last-Event-ID` 头，服务端据此重放缺失的事件。

## 9.6 端到端数据流

一次完整的 SSE 数据流：

```
1. 前端 POST /api/runs 创建 run
   ↓
2. 后端返回 runId
   ↓
3. 前端 EventSource 连接 /api/runs/{runId}/events
   ↓
4. 后端 start(controller) 执行：
   - 重放缓冲事件（如果有）
   - 检查终态（如果已结束则关闭）
   - 订阅实时事件
   - 启动心跳
   ↓
5. Agent CLI 输出 stdout
   ↓
6. StreamHandler 解析为 AgentEvent
   ↓
7. RunManager.emitEvent() 分发：
   - 缓冲到内存
   - 写入 JSONL 日志
   - 调用所有监听器（包括 SSE）
   ↓
8. SSE 监听器发送帧：
   id: 1
   data: {"seq":1,"runId":"abc","event":{"type":"text_delta","delta":"Hello"}}
   
   ↓
9. 前端 EventSource.onmessage 接收
   ↓
10. 解析 SSEEnvelope，提取 AgentEvent
   ↓
11. useChatCore 更新消息状态
   ↓
12. React 重新渲染 UI
```

## 9.7 断线恢复流程

断线恢复的完整流程：

```
[前端]                          [后端]
   │                              │
   ├─ EventSource 连接 ─────────→ │
   │  (Last-Event-ID: 0)          │
   │                              │
   │  ←─────── id: 1 ────────────┤
   │  ←─────── id: 2 ────────────┤
   │  ←─────── id: 3 ────────────┤
   │                              │
   ├─ ✗ 网络断开                  │
   │                              │
   ├─ EventSource 自动重连 ──────→│
   │  (Last-Event-ID: 3)          │
   │                              │
   │  ←─────── id: 4 ────────────┤ (重放 id > 3 的事件)
   │  ←─────── id: 5 ────────────┤
   │                              │
   │  ←─────── id: 6 ────────────┤ (继续实时事件)
```

**关键点**：
- 浏览器自动管理 `Last-Event-ID`
- 服务端通过 `afterId` 参数重放缺失事件
- 如果缺失事件超过 2000 条，需要重新创建 run

## 9.8 心跳的作用

心跳（`:ping\n\n`）有两个作用：

1. **防止超时**：代理和负载均衡器通常会在 60 秒无活动后关闭连接。15 秒的心跳保证连接活跃。
2. **检测断线**：如果前端长时间没收到心跳，可以主动触发重连。

## 9.9 性能优化

### 9.9.1 事件压缩

对于高频的 `text_delta` 事件，可以在服务端合并多个 delta 为一个：

```typescript
// 可选优化：合并连续 text_delta
let pendingText = '';
let flushTimer: NodeJS.Timeout | null = null;

runManager.onEvent(runId, (event) => {
  if (event.type === 'text_delta') {
    pendingText += event.delta;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        const envelope = { seq: lastId, runId, event: { type: 'text_delta', delta: pendingText } };
        controller.enqueue(encoder.encode(`id: ${lastId}\ndata: ${JSON.stringify(envelope)}\n\n`));
        pendingText = '';
        flushTimer = null;
      }, 16); // 约 60fps
    }
  } else {
    // 非 text_delta 事件立即发送
    // ...
  }
});
```

### 9.9.2 背压处理

如果前端处理速度慢，`controller.enqueue` 可能会堆积。可以通过检查 `controller.desiredSize` 实现背压：

```typescript
if (controller.desiredSize !== null && controller.desiredSize <= 0) {
  // 背压：暂停发送
  return;
}
```

## 9.10 Hono 路由集成

SSE 流通过 Hono 路由暴露：

```typescript
// apps/daemon/src/routes/events.ts
export function eventsRoutes(runManager: RunManager): Hono {
  const app = new Hono();

  app.get('/:id/events', (c) => {
    const runId = c.req.param('id');
    const afterId = Number(c.req.query('afterId') ?? 0);

    const { stream, cleanup } = createSSEStream(runManager, runId, afterId);

    c.res.headers.set('Content-Type', 'text/event-stream');
    c.res.headers.set('Cache-Control', 'no-cache');
    c.res.headers.set('Connection', 'keep-alive');

    c.res.body = stream;

    // 客户端断开时清理
    c.res.onClose = () => cleanup();

    return c.res;
  });

  return app;
}
```

**关键响应头**：
- `Content-Type: text/event-stream`：SSE 标准
- `Cache-Control: no-cache`：禁止缓存
- `Connection: keep-alive`：保持连接

## 小结

- **SSE 是单向流**：daemon → web，适合实时事件推送
- **四阶段生命周期**：重放 → 终态检查 → 实时订阅 → 心跳保活
- **事件重放**：通过 `afterId` 支持断线恢复
- **心跳保活**：15 秒一次，防止代理超时
- **自动重连**：浏览器原生 `EventSource` 支持
- **性能优化**：事件合并、背压处理
- **Hono 集成**：`ReadableStream` 原生支持
