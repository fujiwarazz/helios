import type {
  HookBinding,
  SessionStartPayload,
  SessionStartDecision,
  UserPromptSubmitPayload,
  UserPromptSubmitDecision,
  PreToolUsePayload,
  PreToolUseDecision,
  PostToolUsePayload,
  PostToolUseDecision,
  StopPayload,
  StopDecision,
  SessionEndPayload,
} from "@helios/ports";

/**
 * 轻量 Hook 触发器，覆盖完整 agent cycle 共 6 事件。同事件多个 handler 并发执行（allSettled），
 * 按事件类型合并优先级：
 * - SessionStart: additionalContext 拼接（无 block 概念）
 * - UserPromptSubmit: 任一 block → block；text 取最后一个非 undefined 改写；additionalContext 拼接
 * - PreToolUse: deny > ask > allow；input 取最后一个 allow 的改写
 * - PostToolUse: 任一 block → block；output 顺序折叠（后者覆盖）
 * - Stop: 任一 block → block，message 拼接
 * - SessionEnd: 纯通知型，不产生决策
 */
export class HookRunner {
  private readonly start: Array<Extract<HookBinding, { event: "SessionStart" }>["handler"]> = [];
  private readonly submit: Array<Extract<HookBinding, { event: "UserPromptSubmit" }>["handler"]> = [];
  private readonly pre: Array<Extract<HookBinding, { event: "PreToolUse" }>["handler"]> = [];
  private readonly post: Array<Extract<HookBinding, { event: "PostToolUse" }>["handler"]> = [];
  private readonly stop: Array<Extract<HookBinding, { event: "Stop" }>["handler"]> = [];
  private readonly end: Array<Extract<HookBinding, { event: "SessionEnd" }>["handler"]> = [];

  register(bindings: HookBinding[]): void {
    for (const b of bindings) {
      if (b.event === "SessionStart") this.start.push(b.handler);
      else if (b.event === "UserPromptSubmit") this.submit.push(b.handler);
      else if (b.event === "PreToolUse") this.pre.push(b.handler);
      else if (b.event === "PostToolUse") this.post.push(b.handler);
      else if (b.event === "Stop") this.stop.push(b.handler);
      else if (b.event === "SessionEnd") this.end.push(b.handler);
    }
  }

  async runSessionStart(payload: SessionStartPayload): Promise<SessionStartDecision> {
    const results = await settleAll(this.start.map((h) => () => h(payload)));
    const contexts = results
      .filter((r): r is SessionStartDecision => !!r?.additionalContext)
      .map((r) => r.additionalContext!);
    return { additionalContext: contexts.length ? contexts.join("\n") : undefined };
  }

  async runUserPromptSubmit(payload: UserPromptSubmitPayload): Promise<UserPromptSubmitDecision> {
    const results = await settleAll(this.submit.map((h) => () => h(payload)));
    let block = false;
    let text = payload.text;
    let reason: string | undefined;
    const contexts: string[] = [];
    for (const r of results) {
      if (!r) continue;
      if (r.block) block = true;
      if (r.text !== undefined) text = r.text;
      if (r.reason) reason = r.reason;
      if (r.additionalContext) contexts.push(r.additionalContext);
    }
    return { block, text, reason, additionalContext: contexts.length ? contexts.join("\n") : undefined };
  }

  async runPreToolUse(payload: PreToolUsePayload): Promise<PreToolUseDecision> {
    const results = await settleAll(this.pre.map((h) => () => h(payload)));
    let decision: "allow" | "deny" | "ask" = "allow";
    let input = payload.input;
    let reason: string | undefined;
    for (const r of results) {
      if (!r) continue;
      if (r.decision === "deny") {
        decision = "deny";
        reason = r.reason ?? reason;
      } else if (r.decision === "ask" && decision !== "deny") {
        decision = "ask";
        reason = r.reason ?? reason;
      }
      if (r.decision === "allow" && r.input !== undefined) input = r.input;
    }
    return { decision, input, reason };
  }

  async runPostToolUse(payload: PostToolUsePayload): Promise<PostToolUseDecision> {
    const results = await settleAll(this.post.map((h) => () => h(payload)));
    let block = false;
    let output = payload.output;
    let reason: string | undefined;
    for (const r of results) {
      if (!r) continue;
      if (r.block) block = true;
      if (r.output !== undefined) output = r.output;
      if (r.reason) reason = r.reason;
    }
    return { block, output, reason };
  }

  async runStop(payload: StopPayload): Promise<StopDecision> {
    const results = await settleAll(this.stop.map((h) => () => h(payload)));
    let block = false;
    const messages: string[] = [];
    for (const r of results) {
      if (!r) continue;
      if (r.block) block = true;
      if (r.message) messages.push(r.message);
    }
    return { block, message: messages.length ? messages.join("\n") : undefined };
  }

  async runSessionEnd(payload: SessionEndPayload): Promise<void> {
    // 纯通知，不关心返回值，仅靠 allSettled 保证互不影响
    await settleAll(this.end.map((h) => () => h(payload)));
  }
}

async function settleAll<T>(
  thunks: Array<() => T | void | Promise<T | void>>,
): Promise<Array<T | void>> {
  // 用 thunk 包裹：同步抛出的 handler 也会被转成 rejection，不逃逸出 allSettled。
  const settled = await Promise.allSettled(
    thunks.map((fn) => Promise.resolve().then(fn)),
  );
  return settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));
}
