import { execa } from "execa";
import type { Logger } from "@helios/ports";

/** hook 命令默认超时：比 Bash 工具更短，hook 应是轻量判定，不应该跑长任务。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export interface HookCommandContext {
  cwd: string;
  timeoutMs: number;
  logger: Logger;
}

/**
 * spawn 执行一条 hook command：payload 走 stdin JSON，退出码/stdout 决定 decision。
 * 永不 throw —— 任何失败路径（非零退出码/JSON 解析失败/超时/异常）都记录 logger.warn 并返回
 * undefined（等同该 hook 未参与合并），不抛异常逃逸出 HookRunner.settleAll 的上层。
 */
export async function runHookCommand<TPayload, TDecision>(
  command: string,
  payload: TPayload,
  ctx: HookCommandContext,
): Promise<TDecision | undefined> {
  try {
    const res = await execa(command, {
      shell: true,
      cwd: ctx.cwd,
      timeout: ctx.timeoutMs,
      reject: false,
      input: JSON.stringify(payload),
    });
    if (res.exitCode === 2) {
      // 快捷 deny 路径（对齐 valos 语义）：仅对带 decision 字段的事件（PreToolUse）有意义；
      // 其它事件的 handler 层按各自 Decision 形状裁剪使用，多余字段被忽略。
      return { decision: "deny", reason: res.stderr?.trim() || "hook denied" } as unknown as TDecision;
    }
    if (res.exitCode !== 0) {
      ctx.logger.warn(`hook command 非零退出（${res.exitCode}）：${command}`);
      return undefined;
    }
    const stdout = res.stdout?.trim();
    if (!stdout) return undefined; // 无输出 = 无意见，等同不参与合并
    return JSON.parse(stdout) as TDecision;
  } catch (err) {
    ctx.logger.warn(`hook command 执行失败：${command} —— ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** matcher 正则匹配 toolName；构造失败时降级为字符串全等；无 matcher 默认匹配所有。 */
export function matchesHook(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}
