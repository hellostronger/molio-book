# 第 8 章 SQLite 持久层：对话、项目与知识库

> Molio 使用 better-sqlite3 作为持久化层，存储项目、会话、消息、知识库等核心数据。本章将拆解它的数据库设计、迁移策略、以及为什么选择同步 API 而非 ORM。

## 8.1 为什么是 better-sqlite3？

Molio 的持久化需求：
- 数据模型简单且固定（projects, conversations, messages, vaults）
- 单用户、单进程访问（daemon 是单线程 Node.js）
- 需要事务支持（消息写入 + 会话更新时间）
- 本地文件存储（无外部数据库依赖）

| 方案 | 适用场景 | Molio 的选择 |
|------|---------|-------------|
| **SQLite (better-sqlite3)** | 本地应用、嵌入式 | ✅ 选择 |
| **PostgreSQL/MySQL** | 多用户、分布式 | ❌ 过重 |
| **ORM (Prisma/TypeORM)** | 复杂模型、多数据库 | ❌ 过度抽象 |
| **JSON 文件** | 极简配置 | ❌ 无法查询 |

**better-sqlite3 的优势**：
- **同步 API**：避免 async/await 的复杂性
- **WAL 模式**：并发读写性能优秀
- **零配置**：无需安装数据库服务器
- **类型安全**：配合 TypeScript 使用良好

## 8.2 数据库初始化

```typescript
// apps/daemon/src/core/db.ts (简化)
export function openDatabase(dataDir?: string): Database {
  const dir = dataDir ?? path.join(os.homedir(), '.molio');
  const file = path.join(dir, 'app.sqlite');

  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file);
  
  // 启用 WAL 模式（Write-Ahead Logging）
  db.pragma('journal_mode = WAL');
  
  // 启用外键约束
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}
```

**WAL 模式的优势**：
- 读写并发：读操作不会阻塞写操作
- 崩溃恢复：WAL 日志保证数据一致性
- 性能提升：批量写入时性能提升 2-3 倍

## 8.3 数据模型

### 8.3.1 核心表结构

```sql
-- 项目表
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata_json TEXT,          -- JSON 格式的元数据
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 会话表
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT,
  channel_type TEXT NOT NULL DEFAULT 'desktop',  -- 'desktop' | 'weixin' | 'feishu'
  external_session_id TEXT,                      -- 外部渠道的会话 ID
  metadata_json TEXT,
  closed_at INTEGER,                             -- 会话关闭时间（用于 /new 命令）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- 消息表
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,            -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  agent_id TEXT,                 -- 使用的 Agent ID
  run_id TEXT,                   -- 关联的 Run ID
  agent_name TEXT,
  events_json TEXT,              -- 工具调用等事件（JSON 格式）
  started_at INTEGER,
  ended_at INTEGER,
  position INTEGER NOT NULL,     -- 消息在会话中的顺序
  created_at INTEGER NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Vault 表
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,     -- 本地绝对路径
  description TEXT,
  created_at INTEGER NOT NULL
);

-- 知识库操作历史
CREATE TABLE kb_history (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'ingest' | 'lint' | 'edit' | 'import'
  detail TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(vault_id) REFERENCES vaults(id) ON DELETE CASCADE
);
```

### 8.3.2 索引设计

```sql
-- 按项目和更新时间查询会话
CREATE INDEX idx_conv_project
  ON conversations(project_id, updated_at DESC);

-- 按会话和位置查询消息
CREATE INDEX idx_messages_conv
  ON messages(conversation_id, position);

-- 外部会话唯一索引（仅对未关闭的会话）
CREATE UNIQUE INDEX idx_conv_external_session_open
  ON conversations(channel_type, external_session_id)
  WHERE external_session_id IS NOT NULL AND closed_at IS NULL;

-- 知识库历史按时间和 vault 查询
CREATE INDEX idx_kb_history_vault
  ON kb_history(vault_id, created_at DESC);
```

**关键设计**：
- **部分唯一索引**：`idx_conv_external_session_open` 只对 `closed_at IS NULL` 的会话强制唯一性。这允许微信用户使用 `/new` 命令关闭当前会话，开始新会话，而不会违反唯一约束。
- **CASCADE 删除**：删除项目时自动删除所有会话；删除会话时自动删除所有消息。

## 8.4 系统项目

Molio 使用两个隐藏的系统项目：

```typescript
export const CHANNELS_PROJECT_ID = '__molio_channels__';
export const DESKTOP_PROJECT_ID = '__molio_desktop__';
```

- **`__molio_channels__`**：外部渠道（微信、飞书等）的会话都挂在这个项目下
- **`__molio_desktop__`**：桌面端的会话挂在这个项目下

**为什么需要系统项目？**

数据库设计要求 `conversations.project_id NOT NULL`，但外部渠道的会话不属于任何用户项目。解决方案是创建一个隐藏的系统项目，所有外部渠道的会话都挂在这里。

**过滤系统项目**：

```typescript
export function listProjects(db: Database): Project[] {
  const rows = db.prepare(
    'SELECT * FROM projects WHERE id NOT IN (?, ?) ORDER BY updated_at DESC'
  ).all(CHANNELS_PROJECT_ID, DESKTOP_PROJECT_ID);
  return rows.map(rowToProject);
}
```

## 8.5 迁移策略

Molio 使用**增量迁移**：每次启动时检查并添加缺失的列。

```typescript
function migrate(db: Database): void {
  // 创建表（IF NOT EXISTS 保证幂等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (...);
    CREATE TABLE IF NOT EXISTS conversations (...);
    CREATE TABLE IF NOT EXISTS messages (...);
    CREATE TABLE IF NOT EXISTS vaults (...);
    CREATE TABLE IF NOT EXISTS kb_history (...);
  `);

  // 添加缺失的列
  addColumnIfMissing(db, 'conversations', 'channel_type', "TEXT NOT NULL DEFAULT 'desktop'");
  addColumnIfMissing(db, 'conversations', 'external_session_id', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'metadata_json', 'TEXT');
  addColumnIfMissing(db, 'conversations', 'closed_at', 'INTEGER');
  addColumnIfMissing(db, 'messages', 'run_id', 'TEXT');

  // 重建索引
  db.exec(`DROP INDEX IF EXISTS idx_conv_external_session`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_external_session_open
      ON conversations(channel_type, external_session_id)
      WHERE external_session_id IS NOT NULL AND closed_at IS NULL;
  `);
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
```

**迁移策略的优势**：
- **幂等**：多次执行不会出错
- **向后兼容**：旧数据库自动添加新列
- **无需版本号**：通过检查列是否存在来判断是否需要迁移

## 8.6 消息写入：upsertMessage

消息写入使用 upsert 模式（插入或更新）：

```typescript
export function upsertMessage(db: Database, conversationId: string, msg: ChatMessage): void {
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(msg.id);

  if (existing) {
    // 更新现有消息（如：添加工具调用结果）
    db.prepare(`
      UPDATE messages SET
        content = ?,
        agent_id = ?,
        run_id = ?,
        events_json = ?,
        ended_at = ?,
        started_at = COALESCE(started_at, ?)
      WHERE id = ?
    `).run(
      msg.content,
      msg.agentId ?? null,
      msg.runId ?? null,
      msg.tools ? JSON.stringify(msg.tools) : null,
      msg.usage ? Date.now() : null,
      Date.now(),
      msg.id,
    );
  } else {
    // 插入新消息，自动递增 position
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM messages WHERE conversation_id = ?'
    ).get(conversationId);

    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, agent_id, run_id, events_json, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      conversationId,
      msg.role,
      msg.content,
      msg.agentId ?? null,
      msg.runId ?? null,
      msg.tools ? JSON.stringify(msg.tools) : null,
      maxPos.max_pos + 1,
      msg.timestamp || Date.now(),
    );
  }

  // 更新会话的 updated_at
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
}
```

**关键设计**：
- **position 字段**：保证消息顺序，即使 `created_at` 相同
- **events_json**：存储工具调用等事件，JSON 格式便于扩展
- **级联更新**：写入消息时自动更新会话的 `updated_at`

## 8.7 外部会话管理

外部渠道（微信等）的会话通过 `channel_type + external_session_id` 定位：

```typescript
export function getConversationByExternalSession(
  db: Database,
  channelType: string,
  externalSessionId: string,
): Conversation | null {
  // 只返回未关闭的会话
  const row = db.prepare(
    'SELECT * FROM conversations WHERE channel_type = ? AND external_session_id = ? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).get(channelType, externalSessionId);
  return row ? rowToConversation(row) : null;
}

export function closeConversation(db: Database, id: string): void {
  db.prepare('UPDATE conversations SET closed_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), id);
}
```

**`/new` 命令的实现**：

微信用户发送 `/new` 命令时，关闭当前会话，下次消息会创建新会话：

```typescript
// apps/daemon/src/core/weixin/service.ts
if (trimmed === '/new' || trimmed === '/clear' || trimmed === '/重置') {
  const closed = this.conversations.closeExternalSession('weixin', parsed.fromUserId);
  if (closed) {
    await this.sendText(parsed.fromUserId, '已开启新会话。发送消息即可开始新的对话。');
  }
  return;
}
```

## 8.8 历史查询优化

查询会话历史时，需要获取每个会话的最后一条消息和消息总数：

```typescript
export function listConversationHistory(db: Database, limit = 100) {
  const rows = db.prepare(`
    SELECT
      c.*,
      COALESCE(stats.message_count, 0) AS message_count,
      lm.id AS last_id,
      lm.role AS last_role,
      lm.content AS last_content,
      lm.agent_id AS last_agent_id,
      lm.run_id AS last_run_id,
      lm.events_json AS last_events_json,
      lm.created_at AS last_created_at
    FROM conversations c
    LEFT JOIN (
      SELECT conversation_id, COUNT(*) AS message_count, MAX(position) AS max_position
      FROM messages
      GROUP BY conversation_id
    ) stats ON stats.conversation_id = c.id
    LEFT JOIN messages lm
      ON lm.conversation_id = c.id AND lm.position = stats.max_position
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map((row) => ({
    conversation: rowToConversation(row),
    lastMessage: row.last_id ? rowToMessage(row) : null,
    messageCount: Number(row.message_count ?? 0),
  }));
}
```

**优化点**：
- **子查询聚合**：`stats` 子查询一次性计算消息数和最大 position
- **JOIN 最后一条消息**：通过 `position = max_position` 关联最后一条消息
- **避免 N+1 查询**：一次查询获取所有会话及其最后消息

## 8.9 数据目录迁移

Molio 曾经使用 `~/.kge` 作为数据目录，现在迁移到 `~/.molio`：

```typescript
function migrateLegacyDir(): void {
  const legacyDir = path.join(os.homedir(), '.kge');
  const newDir = path.join(os.homedir(), '.molio');

  if (!fs.existsSync(legacyDir) || fs.existsSync(newDir)) return;

  try {
    fs.renameSync(legacyDir, newDir);
    console.log(`Migrated data directory: ${legacyDir} → ${newDir}`);
  } catch (err) {
    console.error(`Failed to migrate ${legacyDir} → ${newDir}:`, err);
  }
}
```

**迁移策略**：
- **一次性**：只有 `~/.molio` 不存在且 `~/.kge` 存在时才执行
- **原子性**：使用 `renameSync`，要么成功要么失败
- **幂等**：多次调用不会出错

## 小结

- **better-sqlite3**：同步 API、WAL 模式、零配置，适合本地应用
- **数据模型**：5 个核心表 + 4 个索引，覆盖项目、会话、消息、知识库
- **系统项目**：`__molio_channels__` 和 `__molio_desktop__` 隐藏系统会话
- **增量迁移**：通过检查列是否存在实现向后兼容
- **消息 upsert**：支持更新现有消息（如添加工具调用结果）
- **外部会话管理**：`channel_type + external_session_id` 定位，支持 `/new` 命令关闭会话
- **历史查询优化**：JOIN + 子查询避免 N+1 问题
