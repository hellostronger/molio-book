# 第 10 章 微信 AI 助手：跨渠道会话编排

> WeixinService 是 Molio 最复杂的业务模块之一。它通过二维码登录个人微信，轮询接收消息，调用本地 Agent 处理，然后将回复发回微信。本章将拆解它的连接状态机、健康探针、统一会话编排，以及如何与 RunManager 协同工作。

## 10.1 架构概览

```
┌──────────────────────────────────────────────────────┐
│                    WeixinService                     │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────┐    │
│  │  登录   │→│  轮询    │→│ 消息处理 & 回复  │    │
│  │ (QR)    │  │ (poll)   │  │                 │    │
│  └─────────┘  └──────────┘  └────────┬────────┘    │
│                                      │              │
│                                      ↓              │
│                              ┌─────────────┐        │
│                              │ RunManager  │        │
│                              │ (Agent 编排)│        │
│                              └─────────────┘        │
│                                      │              │
│                              ┌─────────────┐        │
│                              │ Conversation│        │
│                              │  Service    │        │
│                              └─────────────┘        │
└──────────────────────────────────────────────────────┘
```

## 10.2 连接状态机

WeixinService 维护一个连接状态机，有四种状态：

```typescript
type ConnectionState = 'idle' | 'connecting' | 'polling' | 'unhealthy';
```

| 状态 | 含义 | 触发动作 |
|------|------|---------|
| **idle** | 未连接，无凭证 | 等待 `start()` 或 `beginLogin()` |
| **connecting** | 正在扫码登录 | 显示二维码，轮询扫码状态 |
| **polling** | 正常轮询消息 | 定期调用 `getUpdates()` |
| **unhealthy** | 网络异常 | 停止轮询，启动健康探针 |

状态转换：

```
idle → connecting → polling
  ↑                    ↓
  └──── expired ←── unhealthy
```

- **idle → connecting**：调用 `beginLogin()` 开始扫码
- **connecting → polling**：扫码确认成功，获得 token
- **polling → unhealthy**：网络错误或 session 过期
- **unhealthy → polling**：健康探针检测到网络恢复
- **polling → expired**：收到 `SESSION_EXPIRED_CODE`，清除凭证
- **expired → idle**：需要重新扫码

## 10.3 扫码登录流程

```typescript
// apps/daemon/src/core/weixin/service.ts (简化)
async beginLogin(): Promise<WeixinStatus> {
  this.loginAbort = new AbortController();
  const api = new WeixinApi(cfg.baseUrl || DEFAULT_BASE_URL);
  this.transitionTo('connecting');

  void this.loginLoop(api, this.loginAbort.signal);
  return this.getStatus();
}

private async loginLoop(api: WeixinApi, abortSignal: AbortSignal): Promise<void> {
  let refreshes = 0;
  const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS; // 8 分钟
  let qr = await api.fetchQrCode();

  while (!abortSignal.aborted && Date.now() < deadline) {
    // 显示二维码
    this.status.qrcodeUrl = await toQrDataUrl(qr.qrcode_img_content);
    this.status.loginStatus = 'waiting_scan';

    // 轮询扫码状态
    while (!abortSignal.aborted && Date.now() < deadline) {
      const status = await api.pollQrStatus(qr.qrcode);
      
      if (status.status === 'scaned') {
        this.status.loginStatus = 'scanned';
      } else if (status.status === 'expired') {
        refreshes++;
        if (refreshes >= QR_MAX_REFRESHES) throw new Error('QR expired too many times');
        qr = await api.fetchQrCode(); // 刷新二维码
        break;
      } else if (status.status === 'confirmed') {
        // 登录成功，保存凭证
        const credentials = {
          token: status.bot_token,
          baseUrl: status.baseurl,
          botId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };
        writeCredentials(resolveCredentialsPath(this.getConfig()), credentials);
        this.api = new WeixinApi(credentials.baseUrl, credentials.token);
        this.transitionTo('polling');
        this.startPolling();
        return;
      }

      await this.sleep(1_000, abortSignal);
    }
  }
}
```

**关键设计**：
- **8 分钟超时**：`QR_LOGIN_TIMEOUT_MS = 8 * 60 * 1000`
- **最多刷新 10 次**：`QR_MAX_REFRESHES = 10`
- **凭证持久化**：写入 `~/.molio/weixin-credentials.json`，权限 0600
- **AbortController**：支持取消登录流程

## 10.4 消息轮询

```typescript
private async pollLoop(abortSignal: AbortSignal): Promise<void> {
  while (!abortSignal.aborted && this.api) {
    try {
      const response = await this.api.getUpdates(this.cursor);
      const ret = Number(response.ret ?? 0);

      // Session 过期
      if (ret === SESSION_EXPIRED_CODE) {
        this.transitionTo('expired');
        removeCredentials(resolveCredentialsPath(this.getConfig()));
        this.api = null;
        this.stopHealthProbe();
        return;
      }

      // 其他错误
      if (ret !== 0) throw new Error(response.errmsg);

      this.status.connected = true;
      this.cursor = response.get_updates_buf;

      // 处理消息
      for (const raw of response.msgs) {
        await this.handleRawMessage(raw);
      }
    } catch (err) {
      if (abortSignal.aborted) break;
      // 网络错误 → 转入 unhealthy
      this.status.lastError = err.message;
      this.transitionTo('unhealthy');
      return;
    }
  }
}
```

**关键设计**：
- **cursor 机制**：`get_updates_buf` 作为游标，避免重复接收消息
- **Session 过期处理**：清除凭证，转入 expired 状态
- **错误处理**：网络错误转入 unhealthy，由健康探针处理恢复

## 10.5 健康探针

当连接进入 `unhealthy` 状态时，启动健康探针定期检测网络恢复：

```typescript
private startHealthProbe(): void {
  this.healthTimer = setInterval(() => {
    void this.runHealthProbe();
  }, HEALTH_PROBE_INTERVAL_MS); // 30 秒
  this.healthTimer.unref(); // 不阻止进程退出
}

private async runHealthProbe(): Promise<void> {
  if (!this.api) return;

  const healthy = await this.api.healthCheck();

  if (healthy && this.connectionState === 'unhealthy') {
    // 网络恢复 → 重新开始轮询
    this.status.lastError = null;
    this.startPolling();
    return;
  }

  if (!healthy && this.connectionState === 'polling') {
    // 探针失败 → 说明轮询可能卡住，中止并转入 unhealthy
    this.pollAbort?.abort();
    this.transitionTo('unhealthy');
    this.status.connected = false;
  }
}
```

**为什么需要健康探针？**

- **检测静默挂起**：`getUpdates()` 可能因为网络问题长时间无响应，但不会抛错
- **自动恢复**：网络恢复后自动重新开始轮询，无需用户干预
- **避免盲目重试**：不健康时不轮询，等待探针确认恢复

## 10.6 消息处理流程

```typescript
private async handleRawMessage(raw): Promise<void> {
  const msgId = String(raw.message_id ?? raw.seq ?? '');
  if (this.isDuplicate(msgId)) return; // 去重

  const parsed = parseWeixinMessage(raw);
  if (!parsed) return;

  this.status.lastMessageAt = Date.now();

  // 保存 context token（用于回复）
  if (parsed.contextToken) {
    this.contextTokens.set(parsed.fromUserId, parsed.contextToken);
    this.persistContextTokens();
  }

  // 处理 /new 命令
  const trimmed = parsed.text.trim();
  if (trimmed === '/new' || trimmed === '/clear' || trimmed === '/重置') {
    const closed = this.conversations.closeExternalSession('weixin', parsed.fromUserId);
    if (closed) {
      await this.sendText(parsed.fromUserId, '已开启新会话。');
    }
    return;
  }

  await this.createMolioRun(parsed);
}
```

**关键设计**：
- **消息去重**：`receivedMessageIds` Map 记录最近 7 小时的消息 ID
- **context token**：微信要求回复时带上用户的 context token
- **`/new` 命令**：关闭当前会话，下次消息创建新会话

## 10.7 创建 Agent Run

```typescript
private async createMolioRun(message: ParsedWeixinMessage): Promise<void> {
  const agentId = cfg.defaultAgentId || loadConfig().defaultAgentId;
  if (!agentId) {
    await this.sendText(message.fromUserId, '未设置默认运行时');
    return;
  }

  // 获取或创建会话
  const conversation = this.conversations.getOrCreateExternalConversation({
    channelType: 'weixin',
    externalSessionId: message.fromUserId,
    title: `微信 ${message.fromUserId}`,
  });

  // 获取历史消息
  const history = this.conversations.listHistory(conversation.id);

  // 下载附件（图片/文件）
  await materializeAttachments(message, cwd, this.api?.downloadMedia);

  // 记录用户消息
  this.conversations.appendUserMessage(conversation.id, message.text);

  // 创建 run
  const runId = await this.runManager.createRun({
    agentId,
    cwd,
    message: buildWeixinRunMessage(this.db, message.text, cwd, history.length === 0),
    conversationId: conversation.id,
    history,
  });

  this.status.activeRunId = runId;
  await this.sendText(message.fromUserId, 'Molio 正在处理...');

  // 异步转发回复
  void this.forwardRunReply(runId, message.fromUserId, conversation.id, agentId);
}
```

**关键设计**：
- **统一会话服务**：`getOrCreateExternalConversation` 通过 `channel_type + external_session_id` 定位会话
- **历史传递**：将对话历史传给 Agent，实现多轮对话
- **附件下载**：将微信图片/文件下载到本地 vault
- **异步转发**：`forwardRunReply` 订阅 run 事件，将回复发回微信

## 10.8 转发 Agent 回复

```typescript
private async forwardRunReply(runId, toUserId, conversationId, agentId): Promise<void> {
  let reply = '';
  let settled = false;

  const finish = async (text: string) => {
    if (settled) return; // 幂等
    settled = true;
    unsubscribe?.();
    clearTimeout(timer);
    this.conversations.appendAssistantMessage(conversationId, text, { agentId, runId });
    await this.sendText(toUserId, text);
  };

  const handleEvent = (event: AgentEvent) => {
    if (event.type === 'text_delta') {
      reply += event.delta;
      return;
    }
    if (event.type === 'error') {
      void finish(`Molio 处理失败：${event.message}`);
      return;
    }
    if (event.type === 'turn_end') {
      const text = reply.trim();
      void finish(text || 'Molio 已完成处理，但没有返回文本内容。');
      return;
    }
  };

  // 5 分钟超时
  const timer = setTimeout(() => {
    void finish(reply.trim() || `Molio 仍在处理，稍后可在桌面端查看运行：${runId}`);
  }, RUN_REPLY_TIMEOUT_MS);
  timer.unref();

  // 订阅 run 事件
  unsubscribe = this.runManager.onEvent(runId, handleEvent);
}
```

**关键设计**：
- **幂等 finish**：`settled` 标志防止重复发送
- **文本累积**：将 `text_delta` 累积为完整回复
- **超时保护**：5 分钟未回复则发送提示信息
- **事件订阅**：通过 `runManager.onEvent` 监听 run 事件

## 10.9 发送回复

```typescript
private async sendText(toUserId: string, text: string): Promise<void> {
  if (!this.api) return;
  const contextToken = this.contextTokens.get(toUserId);
  if (!contextToken) return;

  // 长文本分片
  for (const chunk of this.splitText(text)) {
    const response = await this.api.sendText(toUserId, chunk, contextToken);
    const ret = Number(response.ret ?? 0);
    
    // Session 过期，清除 context token
    if (ret === SESSION_EXPIRED_CODE) {
      this.contextTokens.delete(toUserId);
      this.persistContextTokens();
      return;
    }
  }
}

private splitText(text: string): string[] {
  if (text.length <= TEXT_CHUNK_LIMIT) return [text]; // 4000 字符
  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    if (rest.length <= TEXT_CHUNK_LIMIT) {
      chunks.push(rest);
      break;
    }
    // 优先在段落边界切分
    let cut = rest.lastIndexOf('\n\n', TEXT_CHUNK_LIMIT);
    if (cut <= 0) cut = rest.lastIndexOf('\n', TEXT_CHUNK_LIMIT);
    if (cut <= 0) cut = TEXT_CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}
```

**关键设计**：
- **context token**：微信要求回复时带上用户的 context token
- **长文本分片**：超过 4000 字符的文本按段落边界切分
- **Session 过期处理**：清除 context token，等待用户重新发消息

## 10.10 渠道设计原则

Molio 的渠道设计遵循以下原则：

1. **Channel 只做外部通道适配**：微信模块只负责登录、轮询、消息解析、发送回复，不实现长期会话历史
2. **Conversation 是统一会话边界**：所有渠道的对话都写入公共 conversations/messages 存储
3. **Run 是一次执行，不是会话**：每条消息创建一个新的 run，但携带稳定 conversationId 和历史
4. **外部身份映射**：`channel_type + external_session_id` 定位同一个 conversation
5. **渠道模块保持干净**：WeixinService 不直接关心数据库表结构，通过 ConversationService 操作

## 小结

- **连接状态机**：idle → connecting → polling → unhealthy → expired
- **扫码登录**：8 分钟超时，最多刷新 10 次二维码
- **健康探针**：30 秒一次，检测网络恢复
- **消息去重**：7 小时内的消息 ID 去重
- **统一会话**：通过 ConversationService 跨渠道管理会话
- **异步转发**：订阅 run 事件，累积文本，5 分钟超时保护
- **长文本分片**：按段落边界切分，优先在 `\n\n` 处切分
