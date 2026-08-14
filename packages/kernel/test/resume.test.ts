import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest, type SessionMeta } from "../src/index";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

const manifest = (): Manifest => ({
  plugins: [
    { port: "FileSystemPort", package: "@helios/fs-node" },
    { port: "CheckpointPort", package: "@helios/checkpoint-fs" },
    { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
  ],
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

let workDir: string;
let sessionDataRoot: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-resume-"));
  sessionDataRoot = await mkdtemp(join(tmpdir(), "helios-session-state-"));
  return async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(sessionDataRoot, { recursive: true, force: true });
  };
});

describe("会话持久化 kernel-meta.json + resume", () => {
  it("写带版本的 kernel-meta.json，且字段随 turn 更新", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("第一个问题很重要");

    const metaPath = join(workDir, ".helios", "sessions", session.id, "kernel-meta.json");
    expect(await exists(metaPath)).toBe(true);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as SessionMeta;
    expect(meta.schemaVersion).toBe(1);
    expect(meta.id).toBe(session.id);
    expect(meta.title).toBe("第一个问题很重要");
    expect(meta.lastRunIndex).toBe(0);
    expect(meta.lastTurnIndex).toBe(0);
  });

  it("将 Session 数据写入独立 sessionDataRoot，代码工作区不产生会话状态", async () => {
    const kernel = new Kernel({
      workDir,
      sessionDataRoot,
      manifest: manifest(),
      logger: silent,
    });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("separate state");

    const stateDir = join(sessionDataRoot, session.id);
    expect(await exists(join(stateDir, "kernel-meta.json"))).toBe(true);
    expect(await exists(join(stateDir, "log.jsonl"))).toBe(true);
    expect(await exists(join(workDir, ".helios", "sessions", session.id))).toBe(false);

    const resumed = await newStartedKernel({ workDir, sessionDataRoot });
    const restored = await resumed.resumeSession(session.id, { askQuestion: noAsk });
    expect(restored.getHistory().some((message) => textOf(message).includes("separate state"))).toBe(
      true,
    );
  });

  it("首次运行钩子在用户消息落盘前只成功一次，并覆盖完整 run 状态", async () => {
    const events: string[] = [];
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({
      askQuestion: noAsk,
      beforeFirstRun: async (text) => {
        events.push(`before:${text}`);
        expect(session.getHistory()).toEqual([]);
      },
      onRunStateChange: async (state) => {
        events.push(state);
      },
    });

    await session.sendMessage("first");
    await session.sendMessage("second");

    expect(events).toEqual(["before:first", "running", "idle", "running", "idle"]);
  });

  it("首次运行钩子失败时不会创建消息或 turn", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({
      askQuestion: noAsk,
      beforeFirstRun: async () => {
        throw new Error("record create failed");
      },
    });

    await expect(session.sendMessage("never starts")).rejects.toThrow("record create failed");
    expect(session.getHistory()).toEqual([]);
    expect(await exists(join(workDir, ".helios", "sessions", session.id))).toBe(false);
  });

  it("新 Kernel 按 id resume：重建历史 + runIndex 续接 + 新 run 不冲突", async () => {
    // 第一段：产生两个 run
    const k1 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k1.start();
    const s1 = k1.createSession({ askQuestion: noAsk });
    await s1.sendMessage("消息A");
    await s1.sendMessage("消息B");
    const sid = s1.id;
    const historyLenBefore = s1.getHistory().length;

    // 第二段：全新 Kernel（模拟重启），按 id resume
    const k2 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k2.start();
    const s2 = await k2.resumeSession(sid, { askQuestion: noAsk });

    // 历史被完整重建
    expect(s2.id).toBe(sid);
    expect(s2.getHistory().length).toBe(historyLenBefore);
    expect(s2.getHistory().some((m) => textOf(m).includes("消息A"))).toBe(true);
    expect(s2.getHistory().some((m) => textOf(m).includes("消息B"))).toBe(true);

    // 续聊：新 run 的 turnId 用续接后的 runIndex（=2），不与已有 turnId 冲突
    await s2.sendMessage("消息C");
    const logPath = join(workDir, ".helios", "sessions", sid, "log.jsonl");
    const entries = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { kind: string; turnId?: string; runIndex?: number });
    const turns = entries.filter((e) => e.kind === "turn");
    // run 索引应为 0、1、2 各一个 turn（mockLlmTextOnly 每 run 单 turn）
    expect(turns.map((t) => t.runIndex)).toEqual([0, 1, 2]);
    // turnId 全局唯一
    expect(new Set(turns.map((t) => t.turnId)).size).toBe(turns.length);
  });

  it("resume 后 rollback 仍按重建后的历史正确截断", async () => {
    const k1 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k1.start();
    const s1 = k1.createSession({ askQuestion: noAsk });
    await s1.sendMessage("第一轮");
    await s1.sendMessage("第二轮");
    const sid = s1.id;

    const k2 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k2.start();
    const s2 = await k2.resumeSession(sid, { askQuestion: noAsk });

    // 回溯到第二个 run 的首个 turn（runIndex=1）之前
    await s2.rollback(`${sid}-1-0`);
    // 只剩第一轮的历史（user + assistant = 2 条）
    expect(s2.getHistory().length).toBe(2);
    expect(s2.getHistory().some((m) => textOf(m).includes("第二轮"))).toBe(false);
  });

  it("旧格式会话（只有 turns.jsonl，无 log.jsonl）resume 成空会话且不抛错，也不出现在列表里", async () => {
    // 破坏性格式变更：不再兼容旧 turns.jsonl。旧目录与"未知 id"同等对待 —— 静默当空会话，
    // 不 throw（throw 会让 UI 在打开历史会话时直接崩），也不列进 listSessions 免得用户点进空白。
    const directory = join(sessionDataRoot, "sess_legacy");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "turns.jsonl"),
      `${JSON.stringify({ schemaVersion: 1, turnId: "sess_legacy-0-0", runIndex: 0, turnIndex: 0, checkpointRef: { kind: "fs", value: "x" }, anchorNodeId: null, messages: [{ id: "m1", role: "user", content: "old" }] })}\n`,
      "utf8",
    );
    await writeFile(
      join(directory, "kernel-meta.json"),
      JSON.stringify({ schemaVersion: 1, id: "sess_legacy", title: "old", createdAt: 1, updatedAt: 1, lastRunIndex: 0, lastTurnIndex: 0 }),
      "utf8",
    );

    const kernel = await newStartedKernel({ workDir, sessionDataRoot });
    const resumed = await kernel.resumeSession("sess_legacy", { askQuestion: noAsk });
    expect(resumed.getHistory()).toEqual([]);
    expect((await kernel.listSessions()).map((m) => m.id)).not.toContain("sess_legacy");
  });

  it("拒绝未知的日志 schemaVersion", async () => {
    const firstKernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await firstKernel.start();
    const firstSession = firstKernel.createSession({ askQuestion: noAsk });
    await firstSession.sendMessage("future record");
    const logPath = join(workDir, ".helios", "sessions", firstSession.id, "log.jsonl");
    const rows = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // 把最后一条改成来自"未来版本"：必须 fail loud，不能静默跳过后覆盖写丢数据
    rows[rows.length - 1] = { ...rows[rows.length - 1], schemaVersion: 2 };
    await writeFile(logPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

    const secondKernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await secondKernel.start();
    await expect(secondKernel.resumeSession(firstSession.id, { askQuestion: noAsk })).rejects.toThrow(
      /unsupported session log schema version 2/i,
    );
  });

  it("resume 不存在的 id：返回空会话不报错", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const s = await kernel.resumeSession("sess_missing", { askQuestion: noAsk });
    expect(s.getHistory().length).toBe(0);
  });
});

async function newStartedKernel(options: {
  workDir: string;
  sessionDataRoot: string;
}): Promise<Kernel> {
  const kernel = new Kernel({ ...options, manifest: manifest(), logger: silent });
  await kernel.start();
  return kernel;
}
