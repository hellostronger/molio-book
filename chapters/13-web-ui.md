# 第 13 章 Web UI：React 19 组件架构

> Web UI 是 Molio 的用户界面层。它使用 React 19 + TypeScript + Vite 构建，消费 daemon 的 SSE 事件流，提供聊天、知识库、图谱、设置等功能。本章将拆解它的组件架构、状态管理、SSE 消费模式。

## 13.1 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 19 | UI 框架 |
| TypeScript | 5.8 | 类型安全 |
| Vite | 6 | 构建工具 |
| React Router | 6 | 路由 |
| CSS Variables | - | 样式系统 |
| Sigma.js | 3 | 知识图谱可视化 |
| marked | 18 | Markdown 渲染 |

## 13.2 目录结构

```
apps/web/src/
├── main.tsx              入口
├── App.tsx               根组件
├── api/
│   ├── client.ts         HTTP 客户端
│   └── sse.ts            SSE 订阅
├── hooks/
│   ├── useChat.ts        聊天状态管理
│   ├── useChatCore.ts    聊天核心逻辑
│   ├── useAgents.ts      Agent 列表
│   ├── useKnowledge.ts   知识库状态
│   ├── useProjects.ts    项目管理
│   └── useRuntimes.ts    运行时管理
├── components/
│   ├── HomePage.tsx      主页
│   ├── NavRail.tsx       导航栏
│   ├── ChatPane.tsx      消息列表
│   ├── ChatComposer.tsx  输入框
│   ├── AssistantMessage.tsx  助手消息
│   ├── UserMessage.tsx   用户消息
│   ├── ThinkingBlock.tsx 思考过程
│   ├── ToolCard.tsx      工具调用卡片
│   ├── kb/               知识库组件
│   ├── graph/            知识图谱
│   └── settings/         设置页面
├── stores/               全局状态
├── i18n/                 国际化
└── styles/               样式文件
```

## 13.3 路由结构

```typescript
// apps/web/src/App.tsx
<Routes>
  <Route path="/" element={<HomePage />} />
  <Route path="/history" element={<HistoryPage />} />
  <Route path="/knowledge" element={<KnowledgeBasePage />} />
  <Route path="/settings" element={<SettingsPage />} />
  <Route path="/graph" element={<GraphPage />} />
</Routes>
```

**五个主要页面**：
- **HomePage**：聊天界面
- **HistoryPage**：对话历史
- **KnowledgeBasePage**：知识库管理
- **SettingsPage**：设置
- **GraphPage**：知识图谱

## 13.4 聊天状态管理

### 13.4.1 useChat Hook

`useChat` 是聊天功能的核心 Hook：

```typescript
// apps/web/src/hooks/useChat.ts (简化)
export function useChat(options: UseChatOptions) {
  const core = useChatCore({
    agentId,
    initialMessages,
    initialConversationId,
    createRun: async ({ message, history, conversationId }) => {
      return api.createRun({
        agentId,
        message,
        conversationId,
        history,
        cwd,
      });
    },
  });

  const loadConversation = useCallback(async (projId, convId) => {
    const messages = await api.listMessages(projId, convId);
    core.setMessages(messages, convId);
  }, []);

  return {
    messages: core.messages,
    runId: core.runId,
    isRunning: core.isRunning,
    conversationId: core.conversationId,
    send: core.send,
    cancel: core.cancel,
    reset: core.reset,
    loadConversation,
  };
}
```

**职责**：
- 封装 `useChatCore` 和 API 调用
- 管理会话加载
- 支持普通聊天和 Wiki 操作

### 13.4.2 useChatCore Hook

`useChatCore` 是聊天核心逻辑：

```typescript
// apps/web/src/hooks/useChatCore.ts (简化)
export function useChatCore(options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const send = useCallback(async (content: string) => {
    // 添加用户消息
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // 创建 run
    const { runId, conversationId } = await options.createRun({
      message: content,
      history: messages,
      conversationId,
    });
    setRunId(runId);
    setConversationId(conversationId);
    setIsRunning(true);

    // 订阅 SSE
    const es = subscribeToRun(runId, (event) => {
      handleSSEEvent(event);
    });

    // 监听结束事件
    // ...
  }, [messages, conversationId]);

  const handleSSEEvent = useCallback((event: AgentEvent) => {
    if (event.type === 'text_delta') {
      // 更新助手消息
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + event.delta },
          ];
        }
        return [
          ...prev,
          {
            id: randomUUID(),
            role: 'assistant',
            content: event.delta,
            timestamp: Date.now(),
          },
        ];
      });
    }

    if (event.type === 'turn_end') {
      setIsRunning(false);
    }
  }, []);

  return {
    messages,
    isRunning,
    runId,
    conversationId,
    send,
    cancel: () => { /* ... */ },
    reset: () => { /* ... */ },
    setMessages,
  };
}
```

**核心逻辑**：
- **消息状态**：`messages` 数组存储所有消息
- **SSE 订阅**：通过 `subscribeToRun` 订阅事件流
- **增量更新**：`text_delta` 事件追加到助手消息
- **状态管理**：`isRunning` 追踪 run 状态

## 13.5 SSE 消费模式

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
      // 忽略解析错误
    }
  };

  es.onerror = (err) => {
    onError?.(err);
    // EventSource 会自动重连
  };

  return es;
}
```

**关键设计**：
- **EventSource**：浏览器原生 SSE API
- **自动重连**：断线后自动重连
- **错误处理**：`onerror` 回调处理错误

## 13.6 消息渲染

### 13.6.1 助手消息

```typescript
// apps/web/src/components/AssistantMessage.tsx (简化)
export function AssistantMessage({ message }) {
  return (
    <div className="assistant-message">
      {message.thinking && (
        <ThinkingBlock content={message.thinking} />
      )}
      <MarkdownRenderer content={message.content} />
      {message.tools && message.tools.length > 0 && (
        <ToolGroup tools={message.tools} />
      )}
    </div>
  );
}
```

**结构**：
- **思考过程**：可折叠的 `ThinkingBlock`
- **正文内容**：Markdown 渲染
- **工具调用**：`ToolGroup` 显示工具卡片

### 13.6.2 工具卡片

```typescript
// apps/web/src/components/ToolCard.tsx (简化)
export function ToolCard({ tool }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-card">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-status">{tool.status}</span>
      </div>
      {expanded && (
        <div className="tool-content">
          <pre>{JSON.stringify(tool.input, null, 2)}</pre>
          {tool.result && <pre>{tool.result}</pre>}
        </div>
      )}
    </div>
  );
}
```

**交互**：
- **折叠/展开**：点击头部切换展开状态
- **显示输入**：工具调用的参数
- **显示结果**：工具返回的结果

## 13.7 知识库页面

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

## 13.8 知识图谱

```typescript
// apps/web/src/components/graph/GraphPage.tsx (简化)
export function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graph] = useState(() => new Graphology());
  const [renderer, setRenderer] = useState<Sigma | null>(null);

  useEffect(() => {
    // 加载图谱数据
    api.getGraphData().then((data) => {
      // 构建 Graphology 图
      data.nodes.forEach((node) => {
        graph.addNode(node.key, {
          label: node.label,
          x: Math.random(),
          y: Math.random(),
          size: node.linkCount,
        });
      });
      data.edges.forEach((edge) => {
        graph.addEdge(edge.source, edge.target);
      });

      // 运行 ForceAtlas2 布局
      forceAtlas2.assign(graph, {
        iterations: 100,
        settings: {
          linLogMode: true,
          barnesHutOptimize: true,
        },
      });

      // 创建 Sigma 渲染器
      const sigma = new Sigma(graph, containerRef.current!);
      setRenderer(sigma);
    });
  }, []);

  return (
    <div className="graph-page">
      <div ref={containerRef} className="graph-canvas" />
      <Minimap graph={graph} renderer={renderer} />
    </div>
  );
}
```

**技术栈**：
- **Graphology**：图数据结构
- **Sigma.js**：WebGL 渲染
- **ForceAtlas2**：力导向布局

## 13.9 状态管理

Molio 使用 React hooks 进行状态管理，没有使用 Redux 或 Zustand：

```typescript
// 全局状态示例
const [agents, setAgents] = useState<AgentInfo[]>([]);
const [vaults, setVaults] = useState<Vault[]>([]);
const [activeVault, setActiveVault] = useState<Vault | null>(null);
```

**设计原则**：
- **局部状态优先**：只在需要时使用全局状态
- **Hooks 封装**：通过自定义 hooks 封装复杂逻辑
- **Context API**：跨组件共享状态（如主题、语言）

## 13.10 国际化

```typescript
// apps/web/src/i18n/index.ts
export type Locale = 'zh' | 'en';

export const translations = {
  zh: {
    'chat.send': '发送',
    'chat.cancel': '取消',
    'kb.createVault': '创建知识库',
    // ...
  },
  en: {
    'chat.send': 'Send',
    'chat.cancel': 'Cancel',
    'kb.createVault': 'Create Vault',
    // ...
  },
};
```

**使用方式**：

```typescript
import { useTranslation } from '../i18n/LanguageProvider';

function MyComponent() {
  const { t } = useTranslation();
  return <button>{t('chat.send')}</button>;
}
```

## 13.11 样式系统

Molio 使用 CSS Variables 进行样式管理：

```css
/* apps/web/src/styles/tokens.css */
:root {
  --color-primary: #007bff;
  --color-secondary: #6c757d;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --font-size-base: 14px;
  --border-radius: 4px;
}
```

**优势**：
- **主题切换**：通过修改 CSS Variables 实现
- **一致性**：统一的设计 token
- **可维护性**：集中管理样式变量

## 小结

- **React 19 + TypeScript**：现代化前端技术栈
- **Hooks 状态管理**：`useChat`、`useChatCore` 封装聊天逻辑
- **SSE 消费**：`EventSource` 原生 API，自动重连
- **组件架构**：消息、工具卡片、知识库、图谱等组件
- **Sigma.js 图谱**：WebGL 渲染 + ForceAtlas2 布局
- **CSS Variables**：统一的设计 token
- **国际化**：支持中英文切换
