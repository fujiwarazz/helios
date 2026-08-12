import type { Message, Logger } from "@helios/ports";
import { approxTokens } from "./canonical";

/**
 * 上下文预算可观测性（纯观察，不改变任何状态/行为）：估算当前 message path 的 token 数，
 * 超过阈值时记录一次 warning。**不触发 compact、不改写 path、不影响 router decision、不阻断
 * turn**——这不是真正的预算治理，只是"长 run 中途是否可能已超预算"的告警信号。
 *
 * 命名注意：`messagePathApproxTokens` 只是 `approxTokens(path)`（消息路径字符数/4 的粗估），
 * 不包含 system prompt、tool schema、动态 hook context、预留输出 token，也不是 provider 真实
 * tokenization，不能代表 provider 完整 prompt 的真实 token 占用。
 *
 * @returns 本次是否记录了 warning（`true`=已记录，调用方可用于"每 run 只报一次"的去重）。
 */
export function warnIfMessagePathExceeds(
  path: Message[],
  turnId: string,
  thresholdTokens: number | undefined,
  logger: Logger,
): boolean {
  // 阈值边界：未配置 / NaN / Infinity / 0 或负数，一律视为"关闭检查"。
  if (thresholdTokens === undefined || !Number.isFinite(thresholdTokens) || thresholdTokens <= 0) {
    return false;
  }
  const messagePathApproxTokens = approxTokens(path);
  if (messagePathApproxTokens <= thresholdTokens) return false;

  // logger.warn 与 reason 格式化都可能抛（如自定义 toString）——这个函数的目标是"异常绝不穿透"，
  // 格式化/日志失败静默吞掉，不影响返回值语义（已确定超阈值即返回 true）。
  try {
    logger.warn(
      `[turn ${turnId}] message path 估算值（messagePathApproxTokens=${messagePathApproxTokens}）超过阈值 ${thresholdTokens}；` +
        `该值不含 system/tools，不能代表 provider 完整 prompt 的真实 token 占用，仅供观察参考。`,
    );
  } catch {
    // 静默吞掉
  }
  return true;
}
