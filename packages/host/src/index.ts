// ============================================================================
// @helios/host —— Kernel Session ↔ protocol RpcServer 的领域适配层。
// 对应 valos 里 Electron 的 RemoteControlServer 那段"把 Session 绑到 WS"的胶水。
// 领域(kernel)在这里与传输/协议(protocol)对接;将来 electron 宿主直接复用。
// ============================================================================

import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import type { Kernel, Session, AgentEvent } from "@helios/kernel";
import { RpcServer, nodeWsServerTransport, type Transport } from "@helios/protocol";

/**
 * 把一个 Session 绑到给定 transport 上:建 RpcServer + 注册 handlers + 事件广播。
 * 断开时解绑事件监听(否则重连累积监听 → 事件重复广播)。
 */
export function bindSession(
  session: Session,
  transport: Transport,
): { server: RpcServer; dispose(): void } {
  const server = new RpcServer(transport, {
    sessionId: () => session.id,
    history: () => session.getHistory(),
    sendMessage: (p) => session.sendMessage((p as { text: string }).text),
    rollback: (p) => session.rollback((p as { turnId: string }).turnId),
    cancel: () => session.cancel(), // 让外部（UI/Stop 按钮）可真正触发中断
  });
  const unbindEvents = session.on((e: AgentEvent) =>
    server.broadcast(`session:${session.id}`, e, session.id),
  );
  const closeSub = transport.onClose(() => unbindEvents());
  return {
    server,
    dispose(): void {
      unbindEvents();
      closeSub.dispose();
      server.dispose();
    },
  };
}

/** ui-chat 尚无审批 UI,默认自动放行(选第一项)。见 docs 待补项。 */
const autoApprove = async (req: AskQuestionRequest): Promise<AskQuestionResponse> => ({
  answers: [req.options?.[0]?.label ?? "允许"],
});

export interface ServeOptions {
  kernel: Kernel;
  /** 监听端口;传 0 由系统分配,返回值 port 为真实端口。 */
  port: number;
  host?: string;
  /** 每个连接如何建会话。默认每连接一个新会话(对齐 valos"一远程一会话")。 */
  createSession?: (kernel: Kernel) => Session;
  /** 工具审批回调,默认自动放行。 */
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
  const askQuestion = opts.askQuestion ?? autoApprove;
  const createSession =
    opts.createSession ?? ((k: Kernel) => k.createSession({ askQuestion }));

  const wss = new WebSocketServer({ port: opts.port, host: opts.host });
  const bindings = new Set<{ dispose(): void }>();

  wss.on("connection", (conn: NodeWebSocket) => {
    const session = createSession(opts.kernel);
    const transport = nodeWsServerTransport(conn);
    const binding = bindSession(session, transport);
    bindings.add(binding);
    conn.on("close", () => {
      binding.dispose();
      bindings.delete(binding);
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
