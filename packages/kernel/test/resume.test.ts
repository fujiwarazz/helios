import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
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
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-resume-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("会话持久化 meta.json + resume", () => {
  it("写 meta.json，且字段随 turn 更新", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("第一个问题很重要");

    const metaPath = join(workDir, ".helios", "sessions", session.id, "meta.json");
    expect(await exists(metaPath)).toBe(true);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as SessionMeta;
    expect(meta.id).toBe(session.id);
    expect(meta.title).toBe("第一个问题很重要");
    expect(meta.lastRunIndex).toBe(0);
    expect(meta.lastTurnIndex).toBe(0);
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
    const turnsPath = join(workDir, ".helios", "sessions", sid, "turns.jsonl");
    const lines = (await readFile(turnsPath, "utf8")).split("\n").filter((l) => l.trim());
    const parsed = lines.map((l) => JSON.parse(l) as { turnId: string; runIndex: number });
    // run 索引应为 0、1、2 各一个 turn（mockLlmTextOnly 每 run 单 turn）
    expect(parsed.map((p) => p.runIndex)).toEqual([0, 1, 2]);
    // turnId 全局唯一
    expect(new Set(parsed.map((p) => p.turnId)).size).toBe(parsed.length);
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

  it("resume 不存在的 id：返回空会话不报错", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const s = await kernel.resumeSession("sess_missing", { askQuestion: noAsk });
    expect(s.getHistory().length).toBe(0);
  });
});
