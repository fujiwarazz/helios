// ============================================================================
// @helios/host —— Kernel Session ↔ protocol RpcServer 的领域适配层。
// 对应 valos 里 Electron 的 RemoteControlServer 那段"把 Session 绑到 WS"的胶水。
// 领域(kernel)在这里与传输/协议(protocol)对接;将来 electron 宿主直接复用。
// ============================================================================

import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AskQuestionRequest, AskQuestionResponse, Disposable } from "@helios/ports";
import type { Kernel, Session, AgentEvent } from "@helios/kernel";
import {
  RpcServer,
  nodeWsServerTransport,
  electronMainTransport,
  type Transport,
  type ElectronIpcBridge,
  type RpcHandler,
} from "@helios/protocol";
import type {
  BoundSession,
  CloneWorkspaceRequest,
  ImportLocalWorkspaceRequest,
  RepositoryService,
  RuntimeRegistry,
  SessionCatalog,
  SessionLaunchRequest,
  SessionWorkspaceBinding,
  Workspace,
  WorkspaceCatalog,
  WorkspaceSummary,
} from "@helios/workspace";

/**
 * 每连接一个交互式审批器：AskUserQuestion 走这里 → 广播 ask 事件给前端 →
 * 前端 answerQuestion RPC 回传 → resolve 对应 promise。断开时拒绝所有挂起提问。
 * broadcast 在 bindSession 建好 server 后注入；在此之前的提问排队等注入。
 */
interface Approvals {
  askQuestion(req: AskQuestionRequest): Promise<AskQuestionResponse>;
  /** RpcServer 的 answerQuestion 处理器：前端回传答案。 */
  answer(params: unknown): void;
  /** 注入广播函数（server 就绪后）。 */
  attach(broadcast: (channel: string, payload: unknown) => void, sessionId: string): void;
  /** 断开时拒绝所有挂起提问，避免工具永久 pending。 */
  dispose(): void;
}

function createApprovals(): Approvals {
  let seq = 0;
  let bc: ((channel: string, payload: unknown) => void) | undefined;
  let sid = "";
  const pending = new Map<
    string,
    { resolve: (r: AskQuestionResponse) => void; reject: (e: Error) => void }
  >();
  const flushQueue: Array<() => void> = [];

  return {
    askQuestion(req) {
      seq += 1;
      const questionId = `q${seq}`;
      return new Promise<AskQuestionResponse>((resolve, reject) => {
        pending.set(questionId, { resolve, reject });
        const send = (): void => bc?.(`ask:${sid}`, { questionId, ...req });
        if (bc) send();
        else flushQueue.push(send); // server 尚未就位：排队，attach 后发
      });
    },
    answer(params) {
      const { questionId, answers } = (params ?? {}) as {
        questionId?: string;
        answers?: string[];
      };
      if (!questionId) return;
      const p = pending.get(questionId);
      if (!p) return; // 未知/已答：忽略
      pending.delete(questionId);
      p.resolve({ answers: Array.isArray(answers) ? answers : [] });
    },
    attach(broadcast, sessionId) {
      bc = broadcast;
      sid = sessionId;
      flushQueue.splice(0).forEach((fn) => fn());
    },
    dispose() {
      for (const p of pending.values()) p.reject(new Error("连接已断开，审批取消"));
      pending.clear();
    },
  };
}

/**
 * 给 `tool_execution_end` 事件补上服务端算好的渲染描述符：
 * 查 `kernel.getRenderer(name)`（该工具对应的 CapabilityProvider 若注册了 ToolRenderer）算出
 * `ToolRenderDescriptor`，附到事件上随广播下发——两端 UI 直接展示，不必各自维护渲染分支。
 * 未命中（该工具没注册渲染器）时原样返回事件，消费端走本地通用兜底。
 * `toolNames`：本连接内 toolUseId → name 的映射，从 `tool_execution_start` 记录、
 * `tool_execution_end` 时查出并清理（避免长连接下无限增长）。
 */
function attachToolDescriptor(
  kernel: Kernel,
  toolNames: Map<string, string>,
  e: AgentEvent,
): AgentEvent {
  if (e.type === "tool_execution_start") {
    toolNames.set(e.toolUseId, e.name);
    return e;
  }
  if (e.type === "tool_execution_end") {
    const name = toolNames.get(e.toolUseId);
    toolNames.delete(e.toolUseId);
    const renderer = name ? kernel.getRenderer(name) : undefined;
    if (!renderer) return e;
    const status = e.isError ? "error" : "success";
    return { ...e, descriptor: renderer.render(undefined, status, e.output) };
  }
  return e;
}

/**
 * 把一个 Session 绑到给定 transport 上:建 RpcServer + 注册 handlers + 事件广播。
 * 断开时解绑事件监听(否则重连累积监听 → 事件重复广播)。
 * 传入 kernel 以注册内核级只读 RPC（sessions.list / ports.list）+ 按工具名查
 * ToolRenderer（见 attachToolDescriptor）。
 * 传入 approvals 以打通交互式审批（answerQuestion RPC + ask 广播）。
 */
export function bindSession(
  session: Session,
  transport: Transport,
  kernel: Kernel,
  approvals?: Approvals,
  extraHandlers: Record<string, RpcHandler> = {},
): { server: RpcServer; dispose(): void } {
  const server = new RpcServer(transport, {
    sessionId: () => session.id,
    history: () => session.getHistory(),
    sendMessage: (p) => session.sendMessage((p as { text: string }).text),
    rollback: (p) => session.rollback((p as { turnId: string }).turnId),
    cancel: () => session.cancel(), // 让外部（UI/Stop 按钮）可真正触发中断
    // 交互式审批:前端回传答案解阻塞 AskUserQuestion 工具
    answerQuestion: (p) => approvals?.answer(p),
    // 内核级只读 RPC（会话侧无关，但复用同一连接的 RpcServer 派发）
    "sessions.list": () => kernel.listSessions(),
    "ports.list": () => kernel.listPorts(),
    ...extraHandlers,
  });
  approvals?.attach(
    (channel, payload) => server.broadcast(channel, payload, session.id),
    session.id,
  );
  const toolNames = new Map<string, string>();
  const unbindEvents = session.on((e: AgentEvent) =>
    server.broadcast(`session:${session.id}`, attachToolDescriptor(kernel, toolNames, e), session.id),
  );
  const closeSub = transport.onClose(() => unbindEvents());
  return {
    server,
    dispose(): void {
      unbindEvents();
      closeSub.dispose();
      approvals?.dispose();
      server.dispose();
      // SessionEnd：连接关闭 = 本次运行时生命周期结束的通知点（会话数据仍在磁盘，可 resume）。
      // dispose() 内部走 HookRunner.settleAll，不会真正 reject；catch 仅作防御性兜底。
      void session.dispose().catch((err) => {
        console.error("[helios host] session.dispose() 失败：", err);
      });
    },
  };
}

export interface ServeOptions {
  kernel: Kernel;
  /** 监听端口;传 0 由系统分配,返回值 port 为真实端口。 */
  port: number;
  host?: string;
  /** 每个连接如何建会话。默认每连接一个新会话(对齐 valos"一远程一会话")。 */
  createSession?: (kernel: Kernel) => Session;
  /** 工具审批回调;显式提供则覆盖默认的交互式审批（如测试自动放行）。 */
  askQuestion?: (req: AskQuestionRequest) => Promise<AskQuestionResponse>;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * 起一个 WebSocket 服务:每个连接绑一个 Kernel Session。
 * 这就是"未来 app 要写的宿主胶水"的可复用落地。
 */
export function serveKernelOverWs(opts: ServeOptions): Promise<ServeHandle> {
  const wss = new WebSocketServer({ port: opts.port, host: opts.host });
  const bindings = new Set<{ dispose(): void }>();

  wss.on("connection", (conn: NodeWebSocket, req: IncomingMessage) => {
    // URL 上的 ?session=<id>：有则 resume 该历史会话，无则新建（对齐 valos"一连接一会话"）。
    // resume 涉及磁盘 I/O（异步），在会话就绪前先缓冲客户端消息，避免首帧（如 sessionId）
    // 早于 RpcServer 注册而被静默丢弃。会话就绪后回放缓冲并解除临时监听。
    const url = new URL(req.url ?? "/", "ws://localhost");
    const resumeId = url.searchParams.get("session") ?? undefined;

    // 每连接一个交互式审批器；opts.askQuestion 若显式提供（如测试自动放行）则优先用它。
    const approvals = createApprovals();
    const askQuestion = opts.askQuestion ?? approvals.askQuestion;

    const early: unknown[] = [];
    const bufferEarly = (data: unknown): void => {
      early.push(data);
    };
    conn.on("message", bufferEarly);

    const createSession =
      opts.createSession ?? ((k: Kernel) => k.createSession({ askQuestion }));
    const sessionPromise = resumeId
      ? opts.kernel.resumeSession(resumeId, { askQuestion })
      : Promise.resolve(createSession(opts.kernel));

    let disposed = false;
    let binding: { dispose(): void } | undefined;
    conn.on("close", () => {
      disposed = true;
      if (binding) {
        binding.dispose();
        bindings.delete(binding);
      }
    });

    void sessionPromise
      .then((session) => {
        if (disposed) return; // 会话就绪前连接已关闭
        const transport = nodeWsServerTransport(conn);
        binding = bindSession(session, transport, opts.kernel, approvals);
        bindings.add(binding);
        // 解除缓冲监听并回放：transport 的 message 监听已在 bindSession 里就位。
        conn.off("message", bufferEarly);
        for (const data of early) conn.emit("message", data);
      })
      .catch((err) => {
        conn.close(1011, err instanceof Error ? err.message : "会话初始化失败");
      });
  });

  return new Promise<ServeHandle>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const b of bindings) b.dispose();
            bindings.clear();
            wss.close(() => res());
          }),
      });
    });
  });
}

export interface ElectronConnectRequest {
  connectionId: string;
  /** 有则 resume 该历史会话，无则新建（与 serveKernelOverWs 的 `?session=` 语义一致）。 */
  resumeSessionId?: string;
  /** Workspace Host 新会话的稳定 ID 选择；与 resumeSessionId 互斥。 */
  launch?: SessionLaunchRequest;
}

export interface ServeElectronIpcOptions {
  kernel: Kernel;
  /**
   * 该 Electron 应用（通常单窗口）用来跟渲染进程收发帧的 bridge，由调用方（apps/electron
   * 的 main.ts）包一层真实 ipcMain/webContents 传入——host 包本身不 import "electron"，
   * 只认 `@helios/protocol` 定义的这个结构化接口（与 electronMainTransport 消费的是同一个）。
   */
  bridge: ElectronIpcBridge;
  /**
   * 订阅"渲染进程发起新连接请求"：调用方把真实 `ipcMain.handle('helios:connect', ...)` 接到
   * 这里，每次收到请求就调一次 handler；handler 返回的 Promise 会话就绪后才 resolve，
   * 调用方据此让 `ipcMain.handle` 的返回值（ack）延迟到绑定完成——渲染进程的 `connect()`
   * 调用因此天然等到 host 侧准备好才返回，不需要 serveKernelOverWs 那套"缓冲早到消息"的兜底
   * （Electron IPC 请求/响应本身就是可靠有序的）。
   */
  onConnect(handler: (req: ElectronConnectRequest) => Promise<void>): Disposable;
  /** 每个连接如何建会话。默认每连接一个新会话（对齐 valos"一远程一会话"）。 */
  createSession?: (kernel: Kernel) => Session;
  /** 工具审批回调;显式提供则覆盖默认的交互式审批（如测试自动放行）。 */
  askQuestion?: (req: AskQuestionRequest) => Promise<AskQuestionResponse>;
}

export interface ElectronIpcServeHandle {
  dispose(): void;
}

/**
 * 起一个 Electron IPC 宿主：每个"连接请求"（渲染进程新建/切会话时发起）绑一个 Kernel Session。
 * 与 `serveKernelOverWs` 同构（连接受理循环 + transport 包装 + `bindSession`），只是受理方式
 * 从 WS 的 `connection` 事件换成 `onConnect` 订阅——`bindSession` 本身零改动、直接复用。
 */
export function serveKernelOverElectronIpc(opts: ServeElectronIpcOptions): ElectronIpcServeHandle {
  const bindings = new Map<string, { dispose(): void }>();

  const connectSub = opts.onConnect(async ({ connectionId, resumeSessionId }) => {
    const approvals = createApprovals();
    const askQuestion = opts.askQuestion ?? approvals.askQuestion;
    const createSession = opts.createSession ?? ((k: Kernel) => k.createSession({ askQuestion }));
    const session = resumeSessionId
      ? await opts.kernel.resumeSession(resumeSessionId, { askQuestion })
      : createSession(opts.kernel);

    const transport = electronMainTransport(opts.bridge, connectionId);
    const binding = bindSession(session, transport, opts.kernel, approvals);
    bindings.set(connectionId, binding);
    // 连接关闭（渲染进程主动 close 或窗口销毁）时解绑，避免残留 Session 监听。
    transport.onClose(() => {
      binding.dispose();
      bindings.delete(connectionId);
    });
  });

  return {
    dispose(): void {
      connectSub.dispose();
      for (const b of bindings.values()) b.dispose();
      bindings.clear();
    },
  };
}

export interface ServeWorkspaceHostWsOptions {
  registry: RuntimeRegistry;
  catalog: WorkspaceCatalog;
  sessions: SessionCatalog;
  repositories: RepositoryService;
  port: number;
  host?: string;
  /** Feature gate for Code launches and all Workspace mutation RPC. Defaults to true. */
  codeMode?: boolean;
  /** Whether a client may submit Host-local allowlisted paths. Defaults to true. */
  allowLocalImport?: boolean;
  askQuestion?: (req: AskQuestionRequest) => Promise<AskQuestionResponse>;
}

export interface WorkspaceHostCapabilities {
  codeMode: boolean;
  localImport: boolean;
  rollbackMode: "conversation-only";
}

export function serveWorkspaceHostOverWs(
  opts: ServeWorkspaceHostWsOptions,
): Promise<ServeHandle> {
  const wss = new WebSocketServer({ port: opts.port, host: opts.host });
  const bindings = new Set<{ dispose(): void }>();

  wss.on("connection", (conn: NodeWebSocket, req: IncomingMessage) => {
    const approvals = createApprovals();
    const askQuestion = opts.askQuestion ?? approvals.askQuestion;
    const early: unknown[] = [];
    const bufferEarly = (data: unknown): void => {
      early.push(data);
    };
    conn.on("message", bufferEarly);

    let request: { resumeSessionId?: string; launch?: SessionLaunchRequest };
    try {
      request = parseWorkspaceWsRequest(req.url);
      assertCodeModeRequest(request, opts.codeMode ?? true);
    } catch (error) {
      conn.close(1008, error instanceof Error ? error.message : "invalid launch request");
      return;
    }
    const boundPromise = request.resumeSessionId
      ? opts.registry.resumeSession(request.resumeSessionId, { askQuestion })
      : opts.registry.createSession(request.launch ?? { mode: "chat" }, { askQuestion });

    let disposed = false;
    let binding: { dispose(): void } | undefined;
    conn.on("close", () => {
      disposed = true;
      if (binding) {
        binding.dispose();
        bindings.delete(binding);
      }
    });

    void boundPromise
      .then((bound) => {
        if (disposed) {
          void bound.session.dispose().then(() =>
            opts.registry.release(bound.binding.runtimeId!, bound.session.id),
          );
          return;
        }
        const transport = nodeWsServerTransport(conn);
        binding = bindWorkspaceSession(bound, transport, approvals, opts);
        bindings.add(binding);
        conn.off("message", bufferEarly);
        for (const data of early) conn.emit("message", data);
      })
      .catch((error) => {
        conn.close(1011, error instanceof Error ? error.message : "workspace session init failed");
      });
  });

  return new Promise<ServeHandle>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const address = wss.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const binding of bindings) binding.dispose();
            bindings.clear();
            wss.close(() => done());
          }),
      });
    });
  });
}

export interface ServeWorkspaceHostElectronOptions {
  registry: RuntimeRegistry;
  catalog: WorkspaceCatalog;
  sessions: SessionCatalog;
  repositories: RepositoryService;
  bridge: ElectronIpcBridge;
  onConnect(handler: (req: ElectronConnectRequest) => Promise<void>): Disposable;
  codeMode?: boolean;
  allowLocalImport?: boolean;
  askQuestion?: (req: AskQuestionRequest) => Promise<AskQuestionResponse>;
}

export function serveWorkspaceHostOverElectronIpc(
  opts: ServeWorkspaceHostElectronOptions,
): ElectronIpcServeHandle {
  const bindings = new Map<string, { dispose(): void }>();
  const connectSub = opts.onConnect(async (request) => {
    assertExclusiveWorkspaceRequest(request);
    assertCodeModeRequest(request, opts.codeMode ?? true);
    const approvals = createApprovals();
    const askQuestion = opts.askQuestion ?? approvals.askQuestion;
    const bound = request.resumeSessionId
      ? await opts.registry.resumeSession(request.resumeSessionId, { askQuestion })
      : await opts.registry.createSession(request.launch ?? { mode: "chat" }, { askQuestion });
    const transport = electronMainTransport(opts.bridge, request.connectionId);
    const binding = bindWorkspaceSession(bound, transport, approvals, opts);
    bindings.set(request.connectionId, binding);
    transport.onClose(() => {
      binding.dispose();
      bindings.delete(request.connectionId);
    });
  });
  return {
    dispose(): void {
      connectSub.dispose();
      for (const binding of bindings.values()) binding.dispose();
      bindings.clear();
    },
  };
}

function bindWorkspaceSession(
  bound: BoundSession,
  transport: Transport,
  approvals: Approvals,
  services: {
    registry: RuntimeRegistry;
    catalog: WorkspaceCatalog;
    sessions: SessionCatalog;
    repositories: RepositoryService;
    codeMode?: boolean;
    allowLocalImport?: boolean;
  },
): { dispose(): void } {
  let disposed = false;
  const codeMode = services.codeMode ?? true;
  const allowLocalImport = codeMode && (services.allowLocalImport ?? true);
  const mutationHandlers: Record<string, RpcHandler> = codeMode
    ? {
        ...(allowLocalImport
          ? {
              "workspaces.importLocal": async (params: unknown) => {
                const request = params as ImportLocalWorkspaceRequest;
                return toWorkspaceSummary(
                  await services.repositories.importLocalDirectory(request.path, request.name),
                );
              },
            }
          : {}),
        "workspaces.clone": async (params: unknown) => {
          const request = params as CloneWorkspaceRequest;
          return toWorkspaceSummary(
            await services.repositories.cloneRepository(request.remoteUrl, { name: request.name }),
          );
        },
      }
    : {};
  const binding = bindSession(bound.session, transport, bound.kernel, approvals, {
    "host.capabilities": () =>
      ({
        codeMode,
        localImport: allowLocalImport,
        rollbackMode: "conversation-only",
      }) satisfies WorkspaceHostCapabilities,
    "session.workspace": () => withoutRuntimeId(bound.binding),
    "sessions.list": () => services.sessions.list(),
    "workspaces.list": async () =>
      (await services.catalog.list()).map((workspace) => toWorkspaceSummary(workspace)),
    ...mutationHandlers,
  });
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      binding.dispose();
      void bound.session.dispose().then(() =>
        services.registry.release(bound.binding.runtimeId!, bound.session.id),
      );
    },
  };
}

function parseWorkspaceWsRequest(
  requestUrl: string | undefined,
): { resumeSessionId?: string; launch?: SessionLaunchRequest } {
  const url = new URL(requestUrl ?? "/", "ws://localhost");
  const resumeSessionId = url.searchParams.get("resumeSessionId") ?? undefined;
  const launchRaw = url.searchParams.get("launch");
  const launch = launchRaw ? (JSON.parse(launchRaw) as SessionLaunchRequest) : undefined;
  const request = { resumeSessionId, launch };
  assertExclusiveWorkspaceRequest(request);
  return request;
}

function assertExclusiveWorkspaceRequest(request: {
  resumeSessionId?: string;
  launch?: SessionLaunchRequest;
}): void {
  if (request.resumeSessionId && request.launch) {
    throw new Error("resumeSessionId and launch are mutually exclusive");
  }
  if (request.launch && request.launch.mode !== "chat" && request.launch.mode !== "code") {
    throw new Error("launch.mode must be chat or code");
  }
}

function assertCodeModeRequest(
  request: { launch?: SessionLaunchRequest },
  codeMode: boolean,
): void {
  if (!codeMode && request.launch?.mode === "code") {
    throw new Error("Code mode is disabled");
  }
}

function toWorkspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    roots: workspace.roots.map((root) => ({
      id: root.id,
      displayName: root.displayName,
      git: root.git !== undefined,
    })),
  };
}

function withoutRuntimeId(binding: BoundSession["binding"]): SessionWorkspaceBinding {
  const { runtimeId: _runtimeId, ...persisted } = binding;
  return persisted;
}
