import type { Message } from "@helios/ports";

/**
 * 稳定序列化：对象 key 递归排序，使 `{a:1,b:2}` 与 `{b:2,a:1}` 产出同一字符串。
 * 用于工具入参的缓存 key 规范化，以及"打转"信号的同参比对。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** 近似 token 估算：内容字符数 / 4。供 ModelRouter 的廉价难度信号使用（非精确计费）。 */
export function approxTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 4);
}

/** 廉价代码探测：路径里是否出现三反引号代码块。 */
export function pathHasCode(messages: Message[]): boolean {
  return messages.some((m) => typeof m.content === "string" && m.content.includes("```"));
}
