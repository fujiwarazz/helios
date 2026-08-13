import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView, RpcChatClient, type IChatClient, type ConnectionState } from "@helios/ui-chat";
import { RpcClient } from "@helios/protocol/browser";
import type {
  MaterializationStrategy,
  SessionLaunchRequest,
  WorkspaceSummary,
} from "@helios/workspace/types";
import { Sidebar, type NavView } from "./components/Sidebar";
import { ModeSwitch } from "./components/ModeSwitch";
import {
  WorkspaceComposer,
  type WorkspaceSelection,
} from "./components/WorkspaceComposer";
import { Placeholder } from "./pages/Placeholder";
import { PortsPage } from "./pages/PortsPage";
import { connectElectronTransport } from "./electronRpc";
import {
  cloneWorkspace,
  getHostCapabilities,
  getSessionWorkspace,
  listSessions,
  listPorts,
  listWorkspaces,
  type HostCapabilities,
  type SessionMetaView,
  type PortInfoView,
} from "./lib/rpc";

const ACTIVE_SESSION_KEY = "helios.activeSessionId";

type ComposerState =
  | { mode: "chat"; locked: boolean }
  | {
      mode: "code";
      locked: false;
      workspaceId?: string;
      rootId?: string;
      strategy: MaterializationStrategy;
    }
  | {
      mode: "code";
      locked: true;
      workspaceId: string;
      rootId: string;
      strategy: MaterializationStrategy;
    };

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
    // localStorage unavailable: the next launch starts a new Chat.
  }
}

export function launchForComposer(state: ComposerState): SessionLaunchRequest {
  if (state.mode === "chat") return { mode: "chat" };
  if (!state.workspaceId || !state.rootId) return { mode: "chat" };
  return {
    mode: "code",
    workspaceId: state.workspaceId,
    roots: [{ rootId: state.rootId, strategy: state.strategy }],
  };
}

export function shouldResetFailedResume(
  connection: ConnectionState,
  activeSessionId: string | undefined,
): boolean {
  return connection === "closed" && activeSessionId !== undefined;
}

function InjectedApp({ client }: { client: IChatClient }): JSX.Element {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <ChatView client={client} />
    </div>
  );
}

function ManagedApp(): JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(loadActiveSession);
  const [connectedSessionId, setConnectedSessionId] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const [view, setView] = useState<NavView>("chat");
  const [collapsed, setCollapsed] = useState(false);
  const [sessions, setSessions] = useState<SessionMetaView[]>([]);
  const [ports, setPorts] = useState<PortInfoView[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [capabilities, setCapabilities] = useState<HostCapabilities>();
  const [composer, setComposer] = useState<ComposerState>({ mode: "chat", locked: false });
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const [rpc, setRpc] = useState<RpcClient>();
  const launch = useMemo(() => launchForComposer(composer), [composer]);
  const launchKey = JSON.stringify(launch);

  useEffect(() => {
    const parsedLaunch = JSON.parse(launchKey) as SessionLaunchRequest;
    const client = new RpcClient(
      () => connectElectronTransport(activeSessionId, parsedLaunch),
      { maxReconnects: 0 },
    );
    setRpc(client);
    setConnectedSessionId(undefined);
    setConnection("connecting");
    const sub = client.onState((state) => {
      setConnection(state);
      if (shouldResetFailedResume(state, activeSessionId)) {
        saveActiveSession(undefined);
        setActiveSessionId(undefined);
        setComposer({ mode: "chat", locked: false });
      }
    });
    return () => {
      sub.dispose();
      client.close();
    };
  }, [activeSessionId, launchKey, nonce]);

  const chatClient = useMemo<IChatClient | undefined>(
    () => (rpc ? new RpcChatClient(rpc) : undefined),
    [rpc],
  );

  const refresh = useCallback(() => {
    if (!rpc) return;
    void listSessions(rpc).then(setSessions).catch(() => {});
    void listPorts(rpc).then(setPorts).catch(() => {});
    void listWorkspaces(rpc).then(setWorkspaces).catch(() => {});
  }, [rpc]);

  useEffect(() => {
    if (connection !== "open" || !rpc) return;
    let alive = true;
    setNow(Date.now());
    refresh();
    void getHostCapabilities(rpc)
      .then((value) => {
        if (alive) setCapabilities(value);
      })
      .catch(() => {
        if (alive) setCapabilities({ codeMode: false, localImport: false, rollbackMode: "conversation-only" });
      });
    void rpc.call("sessionId").then((id) => {
      if (alive && typeof id === "string" && id) setConnectedSessionId(id);
    }).catch(() => {});
    if (activeSessionId) {
      void getSessionWorkspace(rpc)
        .then((binding) => {
          if (!alive) return;
          const root = binding.roots[0];
          if (binding.mode === "code" && root) {
            setComposer({
              mode: "code",
              locked: true,
              workspaceId: binding.workspaceId,
              rootId: root.rootId,
              strategy: root.strategy,
            });
          } else {
            setComposer({ mode: "chat", locked: true });
          }
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [activeSessionId, connection, refresh, rpc]);

  const onNewChat = useCallback(() => {
    saveActiveSession(undefined);
    setActiveSessionId(undefined);
    setComposer({ mode: "chat", locked: false });
    setNonce((value) => value + 1);
    setView("chat");
  }, []);

  const onSelectSession = useCallback((id: string) => {
    saveActiveSession(id);
    setActiveSessionId(id);
    setComposer({ mode: "chat", locked: true });
    setNonce((value) => value + 1);
    setView("chat");
  }, []);

  const changeMode = (mode: "chat" | "code"): void => {
    if (composer.locked) return;
    setActiveSessionId(undefined);
    saveActiveSession(undefined);
    setComposer(
      mode === "chat"
        ? { mode: "chat", locked: false }
        : { mode: "code", locked: false, strategy: "direct" },
    );
  };

  const changeWorkspace = (selection: WorkspaceSelection): void => {
    if (composer.locked) return;
    setActiveSessionId(undefined);
    saveActiveSession(undefined);
    setComposer({
      mode: "code",
      locked: false,
      workspaceId: selection.workspaceId,
      rootId: selection.rootId,
      strategy: selection.strategy,
    });
  };

  const beforeSubmit = (): void => {
    if (composer.mode === "chat") {
      setComposer({ mode: "chat", locked: true });
      return;
    }
    if (!composer.workspaceId || !composer.rootId) {
      throw new Error("请先选择代码仓库");
    }
    setComposer({
      mode: "code",
      locked: true,
      workspaceId: composer.workspaceId,
      rootId: composer.rootId,
      strategy: composer.strategy,
    });
  };

  const firstSubmitted = (): void => {
    if (connectedSessionId) saveActiveSession(connectedSessionId);
    refresh();
  };

  const composerHeader = capabilities?.codeMode ? (
    <div className="helios-code-composer">
      <ModeSwitch mode={composer.mode} disabled={composer.locked} onChange={changeMode} />
      {composer.mode === "code" ? (
        <WorkspaceComposer
          workspaces={workspaces}
          selection={{
            workspaceId: composer.workspaceId,
            rootId: composer.rootId,
            strategy: composer.strategy,
          }}
          locked={composer.locked}
          onChange={changeWorkspace}
          onClone={async (remoteUrl) => {
            if (!rpc) return undefined;
            const workspace = await cloneWorkspace(rpc, remoteUrl);
            setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
            return workspace;
          }}
          onSelectDirectory={async () => {
            const workspace = await window.heliosDesktop.selectAndImportDirectory();
            if (workspace) {
              setWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
            }
            return workspace;
          }}
        />
      ) : null}
    </div>
  ) : undefined;

  const canSubmit =
    connection === "open" &&
    (composer.mode === "chat" || Boolean(composer.workspaceId && composer.rootId));

  return (
    <div className="helios-app" data-collapsed={collapsed ? "true" : "false"}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        view={view}
        onNavigate={setView}
        sessions={sessions}
        activeSessionId={activeSessionId ?? connectedSessionId}
        connection={connection}
        now={now}
        onNewChat={onNewChat}
        onSelectSession={onSelectSession}
      />
      <main className="helios-main">
        {view === "chat" && chatClient ? (
          <ChatView
            client={chatClient}
            composerHeader={composerHeader}
            canSubmit={canSubmit}
            onBeforeSubmit={beforeSubmit}
            onFirstSubmitted={firstSubmitted}
            rollbackMode="conversation-only"
          />
        ) : view === "ports" ? (
          <PortsPage ports={ports} />
        ) : view === "projects" ? (
          <Placeholder title="Projects" hint="Workspace 管理由 Code 输入区提供。" />
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
