// ============================================================================
// @helios/host —— Kernel Session ↔ protocol RpcServer 的领域适配层。
// 对应 valos 里 Electron 的 RemoteControlServer 那段"把 Session 绑到 WS"的胶水。
// 领域(kernel)在这里与传输/协议(protocol)对接;将来 electron 宿主直接复用。
// ============================================================================

import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import type { Kernel, Session, AgentEvent } from "@helios/kernel";
import { RpcServer, nodeWsServerTransport, type Transport } from "@helios/protocol";

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
 * 把一个 Session 绑到给定 transport 上:建 RpcServer + 注册 handlers + 事件广播。
 * 断开时解绑事件监听(否则重连累积监听 → 事件重复广播)。
 * 传入 kernel 以注册内核级只读 RPC（sessions.list / ports.list）。
 * 传入 approvals 以打通交互式审批（answerQuestion RPC + ask 广播）。
 */
export function bindSession(
  session: Session,
  transport: Transport,
  kernel: Kernel,
  approvals?: Approvals,
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
  });
  approvals?.attach(
    (channel, payload) => server.broadcast(channel, payload, session.id),
    session.id,
  );
  const unbindEvents = session.on((e: AgentEvent) =>
    server.broadcast(`session:${session.id}`, e, session.id),
  );
  const closeSub = transport.onClose(() => unbindEvents());
  return {
    server,
    dispose(): void {
      unbindEvents();
      closeSub.dispose();
      approvals?.dispose();
      server.dispose();
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
