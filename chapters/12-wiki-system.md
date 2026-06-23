# 第 12 章 Wiki 系统：AI 驱动的知识构建

> Wiki 系统是 Molio 的核心创新之一。它通过 AI Agent 自动构建知识索引、导入文件、健康检查、查询知识、归档对话。本章将拆解它的五种操作类型、提示词模板、以及如何与 RunManager 协同工作。

## 12.1 Wiki 系统的价值

传统的知识库管理依赖人工整理：创建索引、分类文件、检查链接。Wiki 系统将这些工作交给 AI：

- **build**：扫描整个 Vault，自动生成 Wiki 索引
- **ingest**：将单个文件导入 Wiki
- **lint**：检查 Wiki 健康状态（死链、孤立节点等）
- **query**：基于 Wiki 知识回答问题
- **save**：将对话内容归档为 Wiki 页面

## 12.2 操作类型

```typescript
// packages/contracts/src/knowledge.ts
type WikiOperationType = 'build' | 'ingest' | 'lint' | 'query' | 'save';
```

| 操作 | 用途 | 触发方式 |
|------|------|---------|
| **build** | 构建 Wiki 索引 | 首次使用 Wiki 时 |
| **ingest** | 导入文件到 Wiki | 右键文件 → 导入 |
| **lint** | 健康检查 | 定期运行 |
| **query** | 知识查询 | 聊天中输入问题 |
| **save** | 归档对话 | 聊天中点击"保存" |

## 12.3 提示词模板

每种操作都有对应的提示词模板：

```typescript
// apps/daemon/src/core/wiki-prompts.ts (简化)

export const WIKI_BUILD_PROMPT = `
你是一个知识库管理助手。你的任务是扫描当前 vault 中的所有文件，构建一个结构化的 Wiki 索引。

请执行以下步骤：
1. 列出所有 .md 文件
2. 提取每个文件的标题和关键概念
3. 分析文件之间的链接关系
4. 生成 Wiki 索引文件 (wiki/index.md)

索引格式：
# Wiki 索引

## 概念
- [[概念A]] - 简要描述
- [[概念B]] - 简要描述

## 关系
- 概念A → 概念B: 关系描述
`;

export const WIKI_INGEST_PROMPT = `
你是一个知识库管理助手。你的任务是将指定文件导入 Wiki。

请执行以下步骤：
1. 读取文件内容
2. 提取关键概念和实体
3. 更新 Wiki 索引，添加新条目
4. 检查是否有死链
`;

export const WIKI_LINT_PROMPT = `
你是一个知识库健康检查助手。请检查 Wiki 的健康状态：

1. 扫描所有 Wiki 文件
2. 检查死链（链接目标不存在）
3. 检查孤立节点（没有被引用的文件）
4. 生成健康报告
`;

export const WIKI_QUERY_PROMPT = `
你是一个知识库问答助手。请基于当前 vault 的 Wiki 知识回答用户问题。

如果 Wiki 中没有相关信息，请明确告知用户。
`;

export const WIKI_SAVE_PROMPT = `
你是一个知识库归档助手。请回顾当前对话，将值得归档的内容保存为 Wiki 页面。

请执行以下步骤：
1. 识别对话中的关键知识点
2. 创建新的 Wiki 页面
3. 更新 Wiki 索引
`;
```

**提示词设计原则**：
- **明确角色**：告诉 Agent 它的角色是"知识库管理助手"
- **步骤化**：将任务分解为明确的步骤
- **格式规范**：指定输出格式（如 Markdown 索引）
- **错误处理**：告诉 Agent 如何处理异常情况

## 12.4 操作路由

Wiki 操作通过 `/api/runs` 路由处理：

```typescript
// apps/daemon/src/routes/runs.ts (简化)
app.post('/', async (c) => {
  const body = await c.req.json<CreateRunRequest>();

  // 处理 Wiki 操作
  if (body.wikiOperation) {
    const vault = body.cwd ? getVaultByPath(db, body.cwd) : null;
    if (!vault) {
      return c.json({ error: 'cwd must point to a vault' }, 400);
    }

    const wikiPrompts: Record<string, string> = {
      build: WIKI_BUILD_PROMPT,
      ingest: WIKI_INGEST_PROMPT,
      lint: WIKI_LINT_PROMPT,
      query: WIKI_QUERY_PROMPT,
      save: WIKI_SAVE_PROMPT,
    };

    const prompt = wikiPrompts[body.wikiOperation];
    let message = body.message;

    switch (body.wikiOperation) {
      case 'build':
        message = `${prompt}\n\n---\n\n请现在开始构建 Wiki。`;
        addKbHistory(db, vault.id, 'ingest', 'Wiki 构建已启动');
        break;
      case 'ingest':
        message = `${prompt}\n\n---\n\n请将以下文件导入 wiki：${body.wikiExtra?.filePath}`;
        addKbHistory(db, vault.id, 'ingest', `已导入 "${body.wikiExtra?.filePath}"`);
        break;
      case 'lint':
        message = `${prompt}\n\n---\n\n请现在对 wiki 进行健康检查。`;
        addKbHistory(db, vault.id, 'lint', 'Wiki 健康检查已启动');
        break;
      case 'query':
        message = `${prompt}\n\n---\n\n用户问题：${body.message}`;
        break;
      case 'save':
        message = `${prompt}\n\n---\n\n${body.message || '请回顾当前对话，将值得归档的内容保存为 wiki 页面。'}`;
        addKbHistory(db, vault.id, 'edit', 'Wiki 归档已启动');
        break;
    }

    // 创建 run
    const runId = await runManager.createRun({
      agentId: body.agentId,
      message,
      cwd: body.cwd,
      conversationId: body.conversationId,
      history: body.history,
    });

    return c.json({ runId, conversationId: conversation.id }, 201);
  }

  // 普通聊天逻辑
  // ...
});
```

**关键设计**：
- **提示词注入**：将 Wiki 提示词模板与用户消息拼接
- **历史记录**：将操作记录到 `kb_history` 表
- **复用 RunManager**：Wiki 操作本质上是一个特殊的 run

## 12.5 Wiki 目录结构

Wiki 系统在 Vault 中创建以下目录结构：

```
vault/
├── *.md              用户文件
└── wiki/             Wiki 系统目录
    ├── index.md      Wiki 索引
    ├── concepts/     概念页面
    │   ├── concept-a.md
    │   └── concept-b.md
    └── relations/    关系页面
        └── relation-a-b.md
```

**关键设计**：
- **wiki 目录**：所有 Wiki 文件集中在 `wiki/` 目录下
- **索引文件**：`wiki/index.md` 是入口点
- **概念与关系分离**：概念页面和关系页面分别存储

## 12.6 前端 Wiki 操作

### 12.6.1 Wiki 聊天面板

```typescript
// apps/web/src/components/kb/WikiChatPanel.tsx (简化)
export function WikiChatPanel({ vaultId, agentId }) {
  const chat = useChat({
    agentId,
    mode: 'wiki',
    vaultId,
  });

  const handleBuild = () => {
    chat.startWikiOperation('build', '构建 Wiki 索引');
  };

  const handleLint = () => {
    chat.startWikiOperation('lint', '检查 Wiki 健康状态');
  };

  const handleQuery = (question: string) => {
    chat.startWikiOperation('query', question);
  };

  return (
    <div className="wiki-chat-panel">
      <div className="wiki-actions">
        <button onClick={handleBuild}>构建索引</button>
        <button onClick={handleLint}>健康检查</button>
      </div>
      <ChatPane messages={chat.messages} />
      <ChatComposer onSend={handleQuery} />
    </div>
  );
}
```

### 12.6.2 文件导入

```typescript
// apps/web/src/components/kb/KbFilePanel.tsx (简化)
const handleIngest = (filePath: string) => {
  chat.startWikiOperation('ingest', `导入文件：${filePath}`, { filePath });
};

// 右键菜单
<ContextMenu>
  <MenuItem onClick={() => handleIngest(file.path)}>导入到 Wiki</MenuItem>
</ContextMenu>
```

### 12.6.3 对话归档

```typescript
// apps/web/src/components/HomePage.tsx (简化)
const handleSave = () => {
  chat.startWikiOperation('save', '归档当前对话');
};

<button onClick={handleSave}>保存到 Wiki</button>
```

## 12.7 Wiki 状态查询

```typescript
// apps/daemon/src/routes/knowledge.ts (简化)
app.get('/vaults/:id/wiki/status', (c) => {
  const vault = getVault(db, c.req.param('id'));
  if (!vault) return c.json({ error: 'Vault not found' }, 404);

  const wikiDir = path.join(vault.path, 'wiki');
  const indexFile = path.join(wikiDir, 'index.md');

  return c.json({
    initialized: fs.existsSync(wikiDir),
    indexExists: fs.existsSync(indexFile),
    wikiDirExists: fs.existsSync(wikiDir),
  });
});
```

**状态检查**：
- **initialized**：Wiki 目录是否存在
- **indexExists**：索引文件是否存在
- **wikiDirExists**：Wiki 目录是否存在

## 12.8 Wiki 工作流程

### 12.8.1 首次构建

```
1. 用户点击"构建索引"
   ↓
2. 前端调用 startWikiOperation('build', ...)
   ↓
3. 后端拼接提示词 + 创建 run
   ↓
4. Agent 扫描 Vault 中的所有 .md 文件
   ↓
5. Agent 提取关键概念和关系
   ↓
6. Agent 创建 wiki/index.md 和概念页面
   ↓
7. 前端刷新文件树，显示 wiki/ 目录
```

### 12.8.2 文件导入

```
1. 用户右键文件 → "导入到 Wiki"
   ↓
2. 前端调用 startWikiOperation('ingest', ..., { filePath })
   ↓
3. 后端拼接提示词 + 创建 run
   ↓
4. Agent 读取文件内容
   ↓
5. Agent 提取关键概念
   ↓
6. Agent 更新 wiki/index.md，添加新条目
   ↓
7. Agent 创建或更新概念页面
```

### 12.8.3 健康检查

```
1. 用户点击"健康检查"
   ↓
2. 前端调用 startWikiOperation('lint', ...)
   ↓
3. 后端拼接提示词 + 创建 run
   ↓
4. Agent 扫描 wiki/ 目录中的所有文件
   ↓
5. Agent 检查死链（链接目标不存在）
   ↓
6. Agent 检查孤立节点（没有被引用的文件）
   ↓
7. Agent 生成健康报告
```

## 12.9 Wiki 与知识图谱的协同

Wiki 系统和知识图谱共享相同的数据源（Vault 中的 Markdown 文件），但侧重点不同：

| 维度 | Wiki 系统 | 知识图谱 |
|------|----------|---------|
| **数据来源** | Wiki 目录 | 所有 .md 文件 |
| **链接解析** | `[[链接]]` 语法 | `[[链接]]` 语法 |
| **可视化** | 文本索引 | 图形化图谱 |
| **交互** | 聊天式操作 | 点击节点跳转 |
| **用途** | 知识构建 | 知识探索 |

**协同方式**：
- Wiki 系统构建的知识索引可以作为知识图谱的输入
- 知识图谱检测的死链可以反馈给 Wiki 系统进行修复

## 12.10 微信端的 Wiki 查询

微信用户也可以查询 Wiki 知识：

```typescript
// apps/daemon/src/core/weixin/service.ts (简化)
private async createMolioRun(message: ParsedWeixinMessage): Promise<void> {
  // 如果 cwd 指向一个 vault，注入 Wiki 查询提示词
  const message = buildWeixinRunMessage(this.db, message.text, cwd, history.length === 0);
  
  const runId = await this.runManager.createRun({
    agentId,
    cwd,
    message,
    conversationId: conversation.id,
    history,
  });
}

// apps/daemon/src/core/weixin/service.ts
export function buildWeixinRunMessage(
  db: Database | undefined,
  text: string,
  cwd: string | undefined,
  isFirstTurn: boolean,
): string {
  const message = buildMolioPrompt(text);
  if (!db || !cwd) return message;

  const vault = getVaultByPath(db, cwd);
  if (!vault) return message;

  // 注入 Wiki 查询提示词
  return `${WIKI_WEIXIN_PROMPT}\n\n---\n\n用户消息：${message}`;
}
```

**关键设计**：
- **自动注入**：如果 cwd 指向 vault，自动注入 Wiki 查询提示词
- **首轮注入**：只在首轮注入，后续轮次通过 transcript 携带

## 小结

- **五种操作类型**：build、ingest、lint、query、save
- **提示词模板**：明确角色、步骤化、格式规范
- **复用 RunManager**：Wiki 操作本质上是特殊的 run
- **Wiki 目录结构**：`wiki/index.md` + 概念页面 + 关系页面
- **前端集成**：WikiChatPanel、右键菜单、归档按钮
- **与知识图谱协同**：共享数据源，互补功能
- **微信端支持**：自动注入 Wiki 查询提示词
