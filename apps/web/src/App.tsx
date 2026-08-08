// apps/web/src/App.tsx —— 浏览器客户端外壳。
// 注入 client 时(测试)直接渲染 ChatView;否则起完整外壳:侧边栏 + 会话持久化 + 页面路由。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ToolStatus } from "@helios/ports";
import { ChatView, RpcChatClient, type IChatClient, type ConnectionState } from "@helios/ui-chat";
import { RpcClient, browserWsClientTransport } from "@helios/protocol/browser";
import { Sidebar, type NavView } from "./components/Sidebar";
import { Placeholder } from "./pages/Placeholder";
import { PortsPage } from "./pages/PortsPage";
import {
  wsUrlFor,
  listSessions,
  listPorts,
  type SessionMetaView,
  type PortInfoView,
} from "./lib/rpc";

/** 极简工具渲染:工具名 + 状态。 */
function renderTool(name: string, _input: unknown, status: ToolStatus) {
  return { label: name, status };
}

const ACTIVE_SESSION_KEY = "helios.activeSessionId";

function loadActiveSession(): string | undefined {
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveActiveSession(id: string | undefined): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else window.localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* localStorage 不可用（隐私模式等）：忽略，退化为刷新丢会话 */
  }
}

/** 测试注入 client:直接渲染 ChatView(不需要宿主/侧边栏)。 */
function InjectedApp({ client }: { client: IChatClient }): JSX.Element {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <ChatView client={client} renderTool={renderTool} />
    </div>
  );
}

function ManagedApp(): JSX.Element {
  // activeSessionId=undefined 表示"新会话"(host 新建);切换时置为目标 id 触发重连。
  // 初值从 localStorage 恢复，使刷新后 resume 同一会话而非新建空会话。
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(loadActiveSession);
  // nonce:即使 id 不变(New chat 连续点)也强制重建 client。
  const [nonce, setNonce] = useState(0);
  const [view, setView] = useState<NavView>("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<SessionMetaView[]>([]);
  const [ports, setPorts] = useState<PortInfoView[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const [rpc, setRpc] = useState<RpcClient | undefined>(undefined);

  // 每个 activeSessionId/nonce 组合建一条新连接。effect 内建、cleanup 内关。
  useEffect(() => {
    const client = new RpcClient(() => browserWsClientTransport(wsUrlFor(activeSessionId)));
    setRpc(client);
    setConnection("connecting");
    const sub = client.onState((s) => setConnection(s));
    return () => {
      sub.dispose();
      client.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, nonce]);

  const chatClient = useMemo<IChatClient | undefined>(
    () => (rpc ? new RpcChatClient(rpc) : undefined),
    [rpc],
  );

  const refresh = useCallback(() => {
    if (!rpc) return;
    listSessions(rpc).then(setSessions).catch(() => {});
    listPorts(rpc).then(setPorts).catch(() => {});
  }, [rpc]);

  // 连接就绪后:拉会话/端口列表 + 记住真实 sessionId(新会话由 host 生成 id),
  // 只写 localStorage 用于"下次刷新"resume;不改 activeSessionId(否则会触发重连、断掉当前连接)。
  useEffect(() => {
    if (connection !== "open" || !rpc) return;
    setNow(Date.now());
    refresh();
    let alive = true;
    rpc
      .call("sessionId")
      .then((id) => {
        if (alive && typeof id === "string" && id) saveActiveSession(id);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [connection, rpc, refresh]);

  const onNewChat = useCallback(() => {
    saveActiveSession(undefined); // 清掉旧 id;连上新会话后 effect 会写入其真实 id
    setActiveSessionId(undefined);
    setNonce((n) => n + 1);
    setView("chat");
  }, []);

  const onSelectSession = useCallback((id: string) => {
    saveActiveSession(id);
    setActiveSessionId(id);
    setNonce((n) => n + 1);
    setView("chat");
  }, []);

  return (
    <div className="helios-app" data-collapsed={collapsed ? "true" : "false"}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
        view={view}
        onNavigate={setView}
        sessions={sessions}
        activeSessionId={activeSessionId}
        connection={connection}
        now={now}
        onNewChat={onNewChat}
        onSelectSession={onSelectSession}
      />
      <main className="helios-main">
        {view === "chat" && chatClient ? (
          <ChatView client={chatClient} renderTool={renderTool} />
        ) : view === "ports" ? (
          <PortsPage ports={ports} />
        ) : view === "projects" ? (
          <Placeholder title="Projects" hint="项目隔离(独立 workDir)为后续迭代项。" />
        ) : view === "artifacts" ? (
          <Placeholder title="Artifacts" hint="产物管理为后续迭代项。" />
        ) : view === "customize" ? (
          <Placeholder title="Customize" hint="主题与偏好设置为后续迭代项。" />
        ) : null}
      </main>
    </div>
  );
}

export function App({ client }: { client?: IChatClient }): JSX.Element {
  if (client) return <InjectedApp client={client} />;
  return <ManagedApp />;
}
