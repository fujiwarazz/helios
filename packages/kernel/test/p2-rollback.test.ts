import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

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
  workDir = await mkdtemp(join(tmpdir(), "helios-p2-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

async function runAndRollback(
  checkpointPackage: string,
  rollbackPolicy: "full" | "conversation-only" = "full",
): Promise<{
  createdBeforeRollback: boolean;
  existsAfterRollback: boolean;
  preservedContent: string;
  historyLen: number;
  /** 回溯后被丢弃的旧叶子是否仍可枚举（非破坏性保证）。 */
  discardedLeafStillListed: boolean;
  discardedLeafId: string;
  session: Awaited<ReturnType<Kernel["createSession"]>>;
}> {
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "CheckpointPort", package: checkpointPackage },
      { port: "LLMProvider", package: fixture("mockLlmWrite.ts") },
    ],
  };
  // turn 开始前就存在的文件，回溯后必须保留
  await writeFile(join(workDir, "keep.txt"), "keep-me", "utf8");

  const kernel = new Kernel({ workDir, manifest, logger: silent });
  await kernel.start();
  const session = kernel.createSession({ askQuestion: noAsk, rollbackPolicy });
  await session.sendMessage("写个文件");

  const createdBeforeRollback = await exists(join(workDir, "roll.txt"));
  const discardedLeafId = session.getDisplayHistory().slice(-1)[0].id;

  // 回溯到该 run 的第 0 个 turn（Write 发生在此 turn），文件应被还原为不存在
  await session.rollback(`${session.id}-0-0`);

  return {
    createdBeforeRollback,
    existsAfterRollback: await exists(join(workDir, "roll.txt")),
    preservedContent: await readFile(join(workDir, "keep.txt"), "utf8"),
    historyLen: session.getHistory().length,
    discardedLeafStillListed: session.listBranches().some((b) => b.leafId === discardedLeafId),
    discardedLeafId,
    session,
  };
}

describe("P2 Turn 回溯 —— CheckpointPort 从 fs 换成 git，Session 与调用方零改动", () => {
  /**
   * historyLen 期望值为 0 而非 1：锚点语义统一为「本 turn 首条消息之前」。
   * 此前运行时锚点取的是 lead userMsg **之后**的 HEAD（回溯后留下一条无应答的用户消息），
   * 而 restore() 回放时又重算成 lead 之前 —— 同一个 rollback 在 resume 前后结果不同。
   * 现统一到「丢弃整个 turn（含用户消息）」：与 UI 文案「此后的对话将被丢弃(可从这里重聊)」
   * 及 CheckpointPort 快照时点（turn 开始、请求被处理之前）一致，也避免回溯后再发消息
   * 出现两条连续 user 消息。
   */
  it("checkpoint-fs：回溯还原文件，整个 turn 离开路径，旧分支仍保留", async () => {
    const r = await runAndRollback("@helios/checkpoint-fs");
    expect(r.createdBeforeRollback).toBe(true);
    expect(r.existsAfterRollback).toBe(false);
    expect(r.preservedContent).toBe("keep-me");
    expect(r.historyLen).toBe(0);
    // 非破坏性：被回溯掉的分支一个节点没删，仍可枚举并切回
    expect(r.discardedLeafStillListed).toBe(true);
    await r.session.switchBranch(r.discardedLeafId);
    expect(r.session.getHistory().length).toBeGreaterThan(0);
  });

  it("checkpoint-git：影子 git 快照行为与 fs 完全一致", async () => {
    const r = await runAndRollback("@helios/checkpoint-git");
    expect(r.createdBeforeRollback).toBe(true);
    expect(r.existsAfterRollback).toBe(false);
    expect(r.preservedContent).toBe("keep-me");
    expect(r.historyLen).toBe(0);
    expect(r.discardedLeafStillListed).toBe(true);
  });

  it("conversation-only 只移动对话 HEAD，不还原 Workspace 文件", async () => {
    const result = await runAndRollback("@helios/checkpoint-fs", "conversation-only");
    expect(result.createdBeforeRollback).toBe(true);
    expect(result.existsAfterRollback).toBe(true);
    expect(result.historyLen).toBe(0);
  });
});

describe("Write/Edit 文件变更归因", () => {
  it("成功 Write 记录同一 toolUseId 的 before/after 并广播 artifact action", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmWrite.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const edits: unknown[] = [];
    const events: unknown[] = [];
    const session = kernel.createSession({
      askQuestion: noAsk,
      recordEdit: async (edit) => {
        edits.push(edit);
        return { workspaceId: "ws_1", rootId: "root_1", relativePath: edit.path };
      },
    });
    session.on((event) => events.push(event));

    await session.sendMessage("write");

    expect(edits).toEqual([
      expect.objectContaining({
        toolUseId: "w1",
        path: "roll.txt",
        operation: "create",
        before: undefined,
        after: "after-turn\n",
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "artifact_action",
        action: "openDiff",
        workspaceId: "ws_1",
        rootId: "root_1",
        relativePath: "roll.txt",
      }),
    );
  });

  it("observer 失败不改变工具成功结果，但会持久化 audit gap 回调", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmWrite.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    const gaps: unknown[] = [];
    const session = kernel.createSession({
      askQuestion: noAsk,
      recordEdit: async () => {
        throw new Error("store unavailable");
      },
      markAuditGap: async (gap) => {
        gaps.push(gap);
      },
    });

    await expect(session.sendMessage("write")).resolves.toBeDefined();
    expect(await readFile(join(workDir, "roll.txt"), "utf8")).toBe("after-turn\n");
    expect(gaps).toEqual([
      expect.objectContaining({ toolUseId: "w1", reason: "store unavailable" }),
    ]);
  });
});
