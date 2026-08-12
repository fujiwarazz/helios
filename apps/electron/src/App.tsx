// apps/electron/src/App.tsx —— Electron 渲染进程外壳。
// 与 apps/web/src/App.tsx 同构,唯一区别是连接建立方式:web 走 browserWsClientTransport(WS),
// 这里走 connectElectronTransport(Electron IPC,见 ../electronRpc.ts)。壳层(Sidebar/pages/
// 状态管理)是各自维护的独立文件,不建立共享依赖(见计划文档"UI 下沉边界"一节)。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView, RpcChatClient, type IChatClient, type ConnectionState } from "@helios/ui-chat";
import { RpcClient } from "@helios/protocol/browser";
import { Sidebar, type NavView } from "./components/Sidebar";
import { Placeholder } from "./pages/Placeholder";
import { PortsPage } from "./pages/PortsPage";
import { connectElectronTransport } from "./electronRpc";
import { listSessions, listPorts, type SessionMetaView, type PortInfoView } from "./lib/rpc";

// 工具卡片渲染不在这里写:大多数工具的 descriptor 已由 host 用 kernel.getRenderer(name)
// 算好随事件下发（见 @helios/host bindSession），ChatView 不传 renderTool 时对没注册渲染器
// 的工具走 @helios/ui-chat 内置的通用兜底。

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
    /* localStorage 不可用:忽略,退化为刷新丢会话 */
  }
}

/** 测试注入 client:直接渲染 ChatView(不需要宿主/侧边栏)。 */
function InjectedApp({ client }: { client: IChatClient }): JSX.Element {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <ChatView client={client} />
    </div>
  );
}

function ManagedApp(): JSX.Element {
  // activeSessionId=undefined 表示"新会话"(host 新建);切换时置为目标 id 触发重连。
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
    const client = new RpcClient(() => connectElectronTransport(activeSessionId));
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
          <ChatView client={chatClient} />
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
