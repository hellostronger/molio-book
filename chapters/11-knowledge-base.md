# 第 11 章 Knowledge Base：本地知识库管理

> Knowledge Base 模块是 Molio 的数据基础。它管理本地 Vault（知识库）的文件系统操作，提供文件树扫描、文件读写、路径安全等功能。本章将拆解它的文件系统抽象、安全机制，以及与 doocs/md 渲染引擎的集成。

## 11.1 Vault 的概念

Vault 是 Molio 对本地知识库的抽象：

```typescript
interface Vault {
  id: string;
  name: string;
  path: string;          // 本地绝对路径
  description?: string;
  fileCount: number;
  createdAt: number;
}
```

**关键特性**：
- **本地文件系统**：Vault 就是本地文件夹，Molio 不修改文件内容
- **兼容 Obsidian**：可以直接打开 Obsidian Vault 目录
- **多 Vault 支持**：可以同时管理多个知识库
- **文件元数据**：存储在 SQLite 的 `vaults` 表中

## 11.2 文件系统操作

`knowledge.ts` 提供了一组文件系统操作函数：

### 11.2.1 文件树扫描

```typescript
// apps/daemon/src/core/knowledge.ts
export function scanTree(vaultPath: string, relBase = ''): TreeNode[] {
  const absDir = relBase ? path.join(vaultPath, relBase) : vaultPath;
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    // 跳过隐藏文件/目录
    if (entry.name.startsWith('.')) continue;

    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = scanTree(vaultPath, relPath);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      const absFile = path.join(absDir, entry.name);
      const stat = fs.statSync(absFile);
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'file',
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      });
    }
  }

  // 排序：目录优先，然后按字母顺序
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}
```

**关键设计**：
- **递归扫描**：`scanTree` 递归扫描子目录
- **过滤隐藏文件**：跳过以 `.` 开头的文件/目录
- **文件类型过滤**：只包含支持的文件类型
- **排序**：目录优先，然后按字母顺序

### 11.2.2 支持的文件类型

```typescript
const TEXT_EXTS = ['.md', '.txt', '.html', '.htm', '.json', '.yaml', '.yml'];
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];
const BINARY_EXTS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'];

function isSupportedFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [...TEXT_EXTS, ...IMAGE_EXTS, ...BINARY_EXTS].includes(ext);
}
```

**三类文件**：
- **文本文件**：读取为 UTF-8 字符串
- **图片文件**：通过 `<img>` 标签内联显示
- **二进制文件**：通过系统默认程序打开

### 11.2.3 文件读取

```typescript
export function readFile(vaultPath: string, relPath: string): FileContent {
  const absFile = path.join(vaultPath, relPath);

  // 安全检查：防止路径穿越
  const resolved = path.resolve(absFile);
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  const stat = fs.statSync(resolved);
  const mimeType = getMimeType(relPath);
  const content = isTextFile(resolved) ? fs.readFileSync(resolved, 'utf-8') : '';

  return {
    path: relPath,
    content,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    mimeType,
  };
}
```

**关键设计**：
- **路径安全检查**：`path.resolve` 后检查是否在 vault 内
- **MIME 类型**：根据扩展名返回 MIME 类型
- **文本 vs 二进制**：文本文件读取内容，二进制文件返回空字符串

## 11.3 路径安全

所有文件操作都包含路径安全检查：

```typescript
// 防止路径穿越攻击
function ensureSafePath(vaultPath: string, relPath: string): string {
  const absFile = path.join(vaultPath, relPath);
  const resolved = path.resolve(absFile);
  
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }
  
  return resolved;
}
```

**攻击场景**：

```typescript
// 恶意输入
relPath = '../../etc/passwd';

// path.resolve 后
resolved = '/etc/passwd';

// 检查失败
if (!resolved.startsWith('/path/to/vault')) {
  throw new Error('Path traversal not allowed');
}
```

## 11.4 文件写入

```typescript
export function writeFile(vaultPath: string, relPath: string, content: string): void {
  const absFile = path.join(vaultPath, relPath);
  const resolved = path.resolve(absFile);

  // 安全检查
  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  // 创建父目录
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
}
```

**关键设计**：
- **自动创建父目录**：`mkdirSync({ recursive: true })`
- **覆盖写入**：`writeFileSync` 会覆盖现有文件

## 11.5 文件删除

```typescript
export async function deleteFile(vaultPath: string, relPath: string): Promise<void> {
  const absFile = path.join(vaultPath, relPath);
  const resolved = path.resolve(absFile);

  if (!resolved.startsWith(path.resolve(vaultPath))) {
    throw new Error('Path traversal not allowed');
  }

  if (fs.existsSync(resolved)) {
    await trash(resolved); // 移动到回收站，而非永久删除
  }
}
```

**关键设计**：
- **使用 trash**：`trash` 库将文件移动到系统回收站，而非永久删除
- **安全检查**：同样需要路径安全检查

## 11.6 API 路由

知识库相关的 API 路由：

```typescript
// apps/daemon/src/routes/knowledge.ts (简化)
export function knowledgeRoutes(db: Database, runManager: RunManager): Hono {
  const app = new Hono();

  // 列出所有 vault
  app.get('/vaults', (c) => {
    const vaults = listVaults(db);
    return c.json({ vaults });
  });

  // 创建 vault
  app.post('/vaults', async (c) => {
    const body = await c.req.json<CreateVaultRequest>();
    const vault = createVault(db, body.name, body.path, body.description);
    return c.json(vault, 201);
  });

  // 获取文件树
  app.get('/vaults/:id/tree', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) return c.json({ error: 'Vault not found' }, 404);
    
    const tree = scanTree(vault.path);
    return c.json({ tree });
  });

  // 读取文件
  app.get('/vaults/:id/files/*', (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) return c.json({ error: 'Vault not found' }, 404);
    
    const relPath = c.req.params['*'];
    const content = readFile(vault.path, relPath);
    return c.json(content);
  });

  // 写入文件
  app.put('/vaults/:id/files/*', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) return c.json({ error: 'Vault not found' }, 404);
    
    const relPath = c.req.params['*'];
    const body = await c.req.text();
    writeFile(vault.path, relPath, body);
    return c.json({ ok: true });
  });

  // 删除文件
  app.delete('/vaults/:id/files/*', async (c) => {
    const vault = getVault(db, c.req.param('id'));
    if (!vault) return c.json({ error: 'Vault not found' }, 404);
    
    const relPath = c.req.params['*'];
    await deleteFile(vault.path, relPath);
    return c.json({ ok: true });
  });

  return app;
}
```

## 11.7 doocs/md 集成

Molio 集成了 doocs/md 作为 Markdown 渲染引擎：

### 11.7.1 Vendor 方式

`@md/core` 未发布到 npm，Molio 将核心代码 vendor 到 `apps/web/vendor/doocs-md/`：

```
apps/web/vendor/doocs-md/
├── src/
│   ├── renderer/     marked 渲染器 + 自定义扩展
│   ├── extensions/   扩展（KaTeX、Mermaid、alert、代码高亮等）
│   ├── theme/        主题系统 + CSS 处理
│   └── utils/        工具函数
├── themes/           主题 CSS（base、default、grace、simple）
└── shared/           共享类型和工具
```

### 11.7.2 渲染组件

```typescript
// apps/web/src/components/kb/MdRenderer.tsx (简化)
export function MdRenderer({ content }: { content: string }) {
  const html = useMemo(() => {
    return marked(content, {
      extensions: [katexExtension, mermaidExtension, alertExtension],
    });
  }, [content]);

  return (
    <div
      className="md-renderer"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
```

**关键设计**：
- **marked v18**：使用最新的 marked 版本
- **扩展系统**：支持 KaTeX（数学公式）、Mermaid（图表）、alert（提示框）
- **主题系统**：支持多种主题（default、grace、simple）

### 11.7.3 排版编辑器

```typescript
// apps/web/src/components/kb/MdTypesetEditor.tsx (简化)
export function MdTypesetEditor({ content, onChange }) {
  return (
    <div className="typeset-editor">
      <div className="editor-pane">
        <MdEditor content={content} onChange={onChange} />
      </div>
      <div className="preview-pane">
        <MdRenderer content={content} />
      </div>
    </div>
  );
}
```

**左右分栏**：
- **左侧**：Markdown 源码编辑
- **右侧**：实时预览

## 11.8 知识图谱

知识图谱模块解析 Vault 中的 Markdown 文件，提取链接关系，构建图谱：

```typescript
// packages/contracts/src/knowledge.ts
interface GraphNode {
  key: string;          // 文件路径
  label: string;        // 显示名称
  path: string;
  linkCount: number;    // 被引用次数
  nodeType?: string;
  deadLink?: boolean;   // 是否是死链
}

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  deadLinks: DeadLinkInfo[];
}
```

**图谱构建**：
1. 扫描所有 `.md` 文件
2. 解析 Markdown 中的 `[[链接]]` 语法
3. 构建节点和边
4. 检测死链（链接目标不存在）

**可视化**：使用 Sigma.js + ForceAtlas2 力导向布局。

## 11.9 前端知识库页面

```typescript
// apps/web/src/components/kb/KnowledgeBasePage.tsx (简化)
export function KnowledgeBasePage({ agentId }) {
  const { vaults, activeVault, tree, fileContent } = useKnowledge();
  const [mode, setMode] = useState<'view' | 'typeset'>('view');

  return (
    <div className="knowledge-base-page">
      <KbFilePanel
        vaults={vaults}
        activeVault={activeVault}
        tree={tree}
      />
      <KbMainContent
        fileContent={fileContent}
        mode={mode}
        onModeChange={setMode}
      />
    </div>
  );
}
```

**布局**：
- **左侧**：文件面板（Vault 列表 + 文件树）
- **右侧**：主内容区（渲染视图 / 排版编辑器）

## 小结

- **Vault 是本地文件夹**：Molio 不修改文件内容，只是提供管理界面
- **文件树扫描**：递归扫描，过滤隐藏文件和不支持的类型
- **路径安全**：所有文件操作都包含 `path.resolve` 安全检查
- **文件删除使用 trash**：移动到回收站，而非永久删除
- **doocs/md 集成**：vendor 方式引入，支持扩展和主题
- **知识图谱**：解析 `[[链接]]` 语法，构建图谱，检测死链
- **排版编辑器**：左右分栏，左侧编辑，右侧实时预览
