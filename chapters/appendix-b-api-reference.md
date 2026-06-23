# 附录 B API 参考

> 本附录提供 Molio daemon 的完整 API 参考，包括所有 REST 端点、请求/响应格式、错误码。

## B.1 基础信息

**Base URL**：`http://localhost:3100`

**认证**：本地应用，无需认证

**CORS**：允许 `localhost:5173`（开发模式）和 `localhost:3100`（生产模式）

**Content-Type**：`application/json`

## B.2 健康检查

### GET /api/health

检查 daemon 是否正常运行。

**响应**：

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

## B.3 关闭

### POST /api/shutdown

优雅关闭 daemon。桌面应用在退出前调用此端点。

**行为**：
1. 清理所有发布桥接
2. 停止微信服务
3. 取消所有活跃 run
4. 关闭数据库
5. 100ms 后退出进程

**响应**：`204 No Content`

## B.4 Agent 管理

### GET /api/agents

列出所有可用的 AI 运行时。

**响应**：

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "available": true,
      "binary": "/usr/local/bin/claude",
      "source": "path",
      "version": "2.1.179",
      "probeError": null,
      "models": [
        { "id": "default", "label": "Default" },
        { "id": "sonnet", "label": "Sonnet (alias)" }
      ],
      "installUrl": "https://code.claude.com/docs/en/setup",
      "installable": true
    }
  ]
}
```

**字段说明**：
- `available`：二进制是否存在且可执行
- `source`：`env-override` | `path` | `well-known` | `fallback-bin` | `not-found`
- `version`：探测到的版本号
- `probeError`：版本探测失败时的错误信息
- `installable`：是否支持一键安装

## B.5 Run 管理

### POST /api/runs

创建新的 run（启动 Agent）。

**请求体**：

```json
{
  "agentId": "claude",
  "message": "帮我写一个 React 组件",
  "model": "sonnet",
  "cwd": "/path/to/vault",
  "conversationId": "conv-123",
  "history": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "你好",
      "timestamp": 1234567890,
      "agentId": "claude"
    }
  ],
  "wikiOperation": "query",
  "wikiExtra": {
    "filePath": "docs/intro.md"
  }
}
```

**字段说明**：
- `agentId`（必填）：运行时 ID
- `message`（必填）：用户消息
- `model`（可选）：模型选择
- `cwd`（可选）：工作目录（通常是 vault 路径）
- `conversationId`（可选）：会话 ID，不提供则创建新会话
- `history`（可选）：历史消息，用于多轮对话
- `wikiOperation`（可选）：Wiki 操作类型（build/ingest/lint/query/save）
- `wikiExtra`（可选）：Wiki 操作额外参数

**响应**：

```json
{
  "runId": "run-abc-123",
  "conversationId": "conv-123"
}
```

**错误码**：
- `400 BAD_REQUEST`：缺少必填字段
- `404 NOT_FOUND`：会话不存在
- `500 CREATE_FAILED`：创建失败

### GET /api/runs

列出所有 run。

**响应**：

```json
{
  "runs": [
    {
      "id": "run-abc-123",
      "agentId": "claude",
      "status": "running",
      "createdAt": 1234567890,
      "lastStopReason": null,
      "error": null
    }
  ]
}
```

**status 取值**：
- `running`：运行中
- `succeeded`：成功完成
- `failed`：失败
- `canceled`：已取消

### GET /api/runs/:id

查询单个 run 的信息。

**响应**：

```json
{
  "id": "run-abc-123",
  "agentId": "claude",
  "status": "running",
  "createdAt": 1234567890,
  "lastStopReason": null,
  "error": null
}
```

**错误码**：
- `404 NOT_FOUND`：run 不存在

### POST /api/runs/:id/messages

向活跃 run 发送后续消息（多轮对话）。

**请求体**：

```json
{
  "message": "继续刚才的话题"
}
```

**响应**：

```json
{
  "ok": true
}
```

**错误码**：
- `400 BAD_REQUEST`：缺少 message 字段
- `400 SEND_FAILED`：发送失败（run 不活跃或 stdin 已关闭）

### DELETE /api/runs/:id

取消 run。

**响应**：`204 No Content`

### GET /api/runs/:id/events

订阅 run 的 SSE 事件流。

**查询参数**：
- `afterId`（可选）：重放此 ID 之后的事件

**响应头**：

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**事件格式**：

```
id: 42
data: {"seq":42,"runId":"run-abc-123","event":{"type":"text_delta","delta":"Hello"}}

```

**心跳**：每 15 秒发送 `:ping\n\n`

### POST /api/runs/:id/tool-result

提交工具调用结果（用于 AskUserQuestion 等需要用户输入的工具）。

**请求体**：

```json
{
  "toolUseId": "tool-123",
  "content": "用户的回答"
}
```

**响应**：

```json
{
  "ok": true
}
```

**错误码**：
- `400 BAD_REQUEST`：缺少字段
- `400 SUBMIT_FAILED`：提交失败

## B.6 配置管理

### GET /api/config

读取配置。

**响应**：

```json
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

### PUT /api/config

更新配置。

**请求体**：部分配置对象

```json
{
  "defaultAgentId": "claude",
  "locale": "en"
}
```

**响应**：更新后的完整配置对象

## B.7 项目管理

### GET /api/projects

列出所有项目（排除系统项目）。

**响应**：

```json
{
  "projects": [
    {
      "id": "proj-123",
      "name": "My Project",
      "metadata": {},
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  ]
}
```

### POST /api/projects

创建项目。

**请求体**：

```json
{
  "name": "My Project",
  "metadata": { "description": "项目描述" }
}
```

**响应**：创建的项目对象（201）

### GET /api/projects/:id

查询项目。

### PUT /api/projects/:id

更新项目。

### DELETE /api/projects/:id

删除项目（级联删除所有会话）。

## B.8 会话管理

### GET /api/conversations?projectId=:id

列出项目的所有会话。

**响应**：

```json
{
  "conversations": [
    {
      "id": "conv-123",
      "projectId": "proj-123",
      "title": "对话标题",
      "channelType": "desktop",
      "externalSessionId": null,
      "metadata": {},
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  ]
}
```

### GET /api/conversations/history

列出会话历史（包含最后一条消息和消息数）。

**查询参数**：
- `limit`（可选，默认 100）

**响应**：

```json
{
  "conversations": [
    {
      "conversation": { ... },
      "lastMessage": {
        "id": "msg-123",
        "role": "assistant",
        "content": "回复内容",
        "timestamp": 1234567890,
        "agentId": "claude"
      },
      "messageCount": 10
    }
  ]
}
```

### GET /api/conversations/:id/messages

列出会话的所有消息。

**响应**：

```json
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "你好",
      "timestamp": 1234567890,
      "agentId": "claude"
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "你好！有什么可以帮你的吗？",
      "timestamp": 1234567891,
      "agentId": "claude",
      "tools": []
    }
  ]
}
```

### POST /api/conversations

创建会话。

**请求体**：

```json
{
  "title": "新对话"
}
```

**响应**：创建的会话对象（201）

### DELETE /api/conversations/:id

删除会话（级联删除所有消息）。

## B.9 知识库管理

### GET /api/knowledge/vaults

列出所有 vault。

**响应**：

```json
{
  "vaults": [
    {
      "id": "vault-123",
      "name": "My Vault",
      "path": "/path/to/vault",
      "description": "知识库描述",
      "fileCount": 100,
      "createdAt": 1234567890
    }
  ]
}
```

### POST /api/knowledge/vaults

创建 vault。

**请求体**：

```json
{
  "name": "My Vault",
  "path": "/path/to/vault",
  "description": "知识库描述"
}
```

**响应**：创建的 vault 对象（201）

### GET /api/knowledge/vaults/:id/tree

获取 vault 的文件树。

**响应**：

```json
{
  "tree": [
    {
      "name": "docs",
      "path": "docs",
      "type": "directory",
      "children": [
        {
          "name": "intro.md",
          "path": "docs/intro.md",
          "type": "file",
          "size": 1234,
          "modifiedAt": 1234567890
        }
      ]
    }
  ]
}
```

### GET /api/knowledge/vaults/:id/files/*

读取文件内容。

**响应**：

```json
{
  "path": "docs/intro.md",
  "content": "# 简介\n\n这是介绍文档。",
  "size": 1234,
  "modifiedAt": 1234567890,
  "mimeType": "text/markdown"
}
```

### PUT /api/knowledge/vaults/:id/files/*

写入文件。

**请求体**：文件内容（纯文本）

**响应**：

```json
{
  "ok": true
}
```

### DELETE /api/knowledge/vaults/:id/files/*

删除文件（移动到回收站）。

**响应**：

```json
{
  "ok": true
}
```

### GET /api/knowledge/vaults/:id/history

获取知识库操作历史。

**查询参数**：
- `limit`（可选，默认 50）

**响应**：

```json
{
  "history": [
    {
      "id": "hist-123",
      "vaultId": "vault-123",
      "action": "ingest",
      "detail": "Wiki 构建已启动",
      "createdAt": 1234567890
    }
  ]
}
```

**action 取值**：`ingest` | `lint` | `edit` | `import`

## B.10 发布

### POST /api/publish

发布到内容平台。

**请求体**：

```json
{
  "platform": "wechat",
  "content": "文章内容",
  "title": "文章标题"
}
```

**响应**：

```json
{
  "ok": true,
  "url": "https://mp.weixin.qq.com/..."
}
```

## B.11 知识图谱

### GET /api/graph?vaultId=:id

获取知识图谱数据。

**响应**：

```json
{
  "nodes": [
    {
      "key": "docs/intro.md",
      "label": "简介",
      "path": "docs/intro.md",
      "linkCount": 5,
      "nodeType": "document",
      "deadLink": false
    }
  ],
  "edges": [
    {
      "source": "docs/intro.md",
      "target": "docs/getting-started.md"
    }
  ],
  "deadLinks": [
    {
      "sourceFile": "docs/intro.md",
      "targetName": "non-existent.md"
    }
  ]
}
```

## B.12 微信服务

### GET /api/weixin/status

获取微信服务状态。

**响应**：

```json
{
  "enabled": true,
  "loginStatus": "logged_in",
  "connected": true,
  "qrcodeUrl": "",
  "lastError": null,
  "lastMessageAt": 1234567890,
  "activeRunId": null,
  "hasCredentials": true,
  "connectionState": "polling"
}
```

**loginStatus 取值**：
- `idle`：未登录
- `waiting_scan`：等待扫码
- `scanned`：已扫码
- `logged_in`：已登录
- `error`：错误

**connectionState 取值**：
- `idle`：空闲
- `connecting`：连接中
- `polling`：轮询中
- `unhealthy`：不健康

### POST /api/weixin/login

开始微信登录。

**响应**：微信服务状态对象

### POST /api/weixin/stop

停止微信服务。

**响应**：微信服务状态对象

### POST /api/weixin/disconnect

断开微信连接（清除凭证）。

**响应**：微信服务状态对象

### PUT /api/weixin/config

更新微信配置。

**请求体**：

```json
{
  "enabled": true,
  "defaultAgentId": "claude"
}
```

**响应**：微信服务状态对象

## B.13 错误格式

所有 API 错误使用统一格式：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述"
  }
}
```

**常见错误码**：
- `BAD_REQUEST`：请求参数错误
- `NOT_FOUND`：资源不存在
- `CREATE_FAILED`：创建失败
- `SEND_FAILED`：发送失败
- `SUBMIT_FAILED`：提交失败

## B.14 SSE 事件类型

完整的 AgentEvent 类型定义：

```typescript
type AgentEvent =
  | { type: 'status'; label: string; model?: string; ttftMs?: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: UsageInfo; costUsd?: number; durationMs?: number }
  | { type: 'error'; message: string; raw?: string }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'raw'; line: string };
```

**SSEEnvelope 格式**：

```json
{
  "seq": 42,
  "runId": "run-abc-123",
  "event": { "type": "text_delta", "delta": "Hello" }
}
```

## 小结

- **RESTful API**：标准的 HTTP 方法和状态码
- **SSE 事件流**：实时推送 Agent 事件
- **统一错误格式**：`{ error: { code, message } }`
- **完整的 CRUD**：项目、会话、知识库、配置
- **微信集成**：登录、状态查询、配置管理
- **知识图谱**：节点、边、死链检测
