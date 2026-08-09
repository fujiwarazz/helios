import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HookBinding,
  Logger,
  PreToolUseDecision,
  PostToolUseDecision,
  StopDecision,
  UserPromptSubmitDecision,
  SessionStartDecision,
} from "@helios/ports";
import { runHookCommand, matchesHook, DEFAULT_HOOK_TIMEOUT_MS } from "./hookCommandExecutor";

export interface HookConfigEntry {
  event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd";
  /** 正则，只对 PreToolUse/PostToolUse 有意义（按 toolName 匹配）；其余事件无 toolName，忽略不报错 */
  matcher?: string;
  command: string;
  /** 毫秒，覆盖默认值 */
  timeout?: number;
}

const HOOK_EVENTS = new Set<HookConfigEntry["event"]>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]);

function validateEntry(raw: unknown, logger: Logger): HookConfigEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    logger.warn(`hooks.json 条目非对象，跳过：${JSON.stringify(raw)}`);
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.event !== "string" || !HOOK_EVENTS.has(o.event as HookConfigEntry["event"])) {
    logger.warn(`hooks.json 条目 event 字段非法，跳过：${JSON.stringify(raw)}`);
    return undefined;
  }
  if (typeof o.command !== "string" || o.command.trim() === "") {
    logger.warn(`hooks.json 条目 command 字段非法，跳过：${JSON.stringify(raw)}`);
    return undefined;
  }
  if (o.matcher !== undefined && typeof o.matcher !== "string") {
    logger.warn(`hooks.json 条目 matcher 字段非法，跳过：${JSON.stringify(raw)}`);
    return undefined;
  }
  if (o.timeout !== undefined && typeof o.timeout !== "number") {
    logger.warn(`hooks.json 条目 timeout 字段非法，跳过：${JSON.stringify(raw)}`);
    return undefined;
  }
  return {
    event: o.event as HookConfigEntry["event"],
    command: o.command,
    matcher: o.matcher as string | undefined,
    timeout: o.timeout as number | undefined,
  };
}

async function loadFile(path: string, logger: Logger): Promise<HookConfigEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return []; // 文件不存在：静默跳过
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`hooks.json 解析失败，跳过：${path} —— ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const hooksField = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooksField)) return [];
  const entries: HookConfigEntry[] = [];
  for (const item of hooksField) {
    const entry = validateEntry(item, logger);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * 读 ~/.helios/hooks.json（用户级）+ <workDir>/.helios/hooks.json（项目级），全部追加返回，
 * 不做覆盖判定（对齐 HookRunner "同事件多 handler 全部执行" 的既有语义）。
 * 文件不存在/JSON 损坏/条目非法：跳过并 logger.warn，不中止启动。
 */
export async function loadHookConfig(workDir: string, logger: Logger): Promise<HookConfigEntry[]> {
  const userEntries = await loadFile(join(homedir(), ".helios", "hooks.json"), logger);
  const projectEntries = await loadFile(join(workDir, ".helios", "hooks.json"), logger);
  return [...userEntries, ...projectEntries];
}

export interface ToHookBindingsContext {
  workDir: string;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * 校验通过的配置条目转成 HookRunner 可 register 的 HookBinding[]；
 * handler 内部调用 hookCommandExecutor.runHookCommand()。
 */
export function toHookBindings(entries: HookConfigEntry[], ctx: ToHookBindingsContext): HookBinding[] {
  const defaultTimeoutMs = ctx.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  return entries.map((entry): HookBinding => {
    const runCtx = { cwd: ctx.workDir, timeoutMs: entry.timeout ?? defaultTimeoutMs, logger: ctx.logger };

    switch (entry.event) {
      case "PreToolUse":
        return {
          event: "PreToolUse",
          handler: async (payload) => {
            if (!matchesHook(entry.matcher, payload.toolName)) return undefined;
            return runHookCommand<typeof payload, PreToolUseDecision>(entry.command, payload, runCtx);
          },
        };
      case "PostToolUse":
        return {
          event: "PostToolUse",
          handler: async (payload) => {
            if (!matchesHook(entry.matcher, payload.toolName)) return undefined;
            return runHookCommand<typeof payload, PostToolUseDecision>(entry.command, payload, runCtx);
          },
        };
      case "Stop":
        return {
          event: "Stop",
          handler: async (payload) => runHookCommand<typeof payload, StopDecision>(entry.command, payload, runCtx),
        };
      case "UserPromptSubmit":
        return {
          event: "UserPromptSubmit",
          handler: async (payload) =>
            runHookCommand<typeof payload, UserPromptSubmitDecision>(entry.command, payload, runCtx),
        };
      case "SessionStart":
        return {
          event: "SessionStart",
          handler: async (payload) =>
            runHookCommand<typeof payload, SessionStartDecision>(entry.command, payload, runCtx),
        };
      case "SessionEnd":
        return {
          event: "SessionEnd",
          handler: async (payload) => {
            await runHookCommand(entry.command, payload, runCtx); // 纯通知，忽略返回值
          },
        };
    }
  });
}
