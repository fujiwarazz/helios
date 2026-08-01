import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";

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
    { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
  ],
});

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-tree-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("消息树 —— parentId 链 + 退化线性", () => {
  it("无分支时 getHistory 等价线性历史；每个非根节点 parentId 指向前一节点", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    await session.sendMessage("A");
    await session.sendMessage("B");

    const history = session.getHistory();
    // 两 run，每 run 一 user + 一 assistant = 4 条
    expect(history.length).toBe(4);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].parentId).toBe(history[i - 1].id);
    }
    expect(history[0].parentId ?? null).toBeNull();
  });
});

describe("消息树 —— fork/switchBranch 不删旧分支", () => {
  it("fork 回到旧节点长出新分支，旧分支仍可 switchBranch 切回", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const events: AgentEvent[] = [];
    const session = kernel.createSession({ askQuestion: noAsk });
    session.on((e) => events.push(e));

    await session.sendMessage("第一轮");
    const afterRun1 = session.getHistory();
    const branchPointId = afterRun1[afterRun1.length - 1].id; // run1 的 assistant
    const oldLeafId = branchPointId;

    await session.sendMessage("MAINLINE"); // 沿主线继续
    const mainLeaf = session.getHistory();
    const mainLeafId = mainLeaf[mainLeaf.length - 1].id;
    expect(mainLeaf.some((m) => textOf(m).includes("MAINLINE"))).toBe(true);

    // fork 回 run1 末端，长出另一条分支
    session.fork(branchPointId);
    expect(events.some((e) => e.type === "head_changed" && e.headId === branchPointId)).toBe(true);
    await session.sendMessage("ALTBRANCH");
    const branchB = session.getHistory();
    expect(branchB.some((m) => textOf(m).includes("ALTBRANCH"))).toBe(true);
    expect(branchB.some((m) => textOf(m).includes("MAINLINE"))).toBe(false); // 不含主线分支内容

    // 旧主线分支未被删除，可切回
    session.switchBranch(mainLeafId);
    const backToMain = session.getHistory();
    expect(backToMain.some((m) => textOf(m).includes("MAINLINE"))).toBe(true);
    expect(backToMain.some((m) => textOf(m).includes("ALTBRANCH"))).toBe(false);

    // 两条分支都在（含被 fork 出的旧叶子祖先），listBranches 至少枚举出两个叶子
    const leaves = session.listBranches().map((b) => b.leafId);
    expect(leaves).toContain(mainLeafId);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    void oldLeafId;
  });

  it("fork 不存在的节点抛错", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("x");
    expect(() => session.fork("nope")).toThrow(/node 不存在/);
  });
});

describe("compact-on-tree —— 部分覆盖不丢近端上下文", () => {
  it("summary 只覆盖前缀时，未覆盖的近端节点 re-parent 到 summary 之后仍在路径上", async () => {
    const kernel = new Kernel({
      workDir,
      manifest: {
        plugins: [
          { port: "FileSystemPort", package: "@helios/fs-node" },
          { port: "CompactStrategyPort", package: fixture("mockCompactPartial.ts") },
          { port: "LLMProvider", package: fixture("mockLlmCounter.ts") },
        ],
      },
      logger: silent,
    });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    await session.sendMessage("ALPHA_FIRST_USER");
    const afterRun1 = session.getHistory();
    const run1AssistantText = textOf(afterRun1.find((m) => m.role === "assistant")!);

    // run2 开头触发部分覆盖压缩：覆盖 {u1}，保留 a1（近端 tail）
    await session.sendMessage("BETA_SECOND_USER");
    const history = session.getHistory();

    // 被覆盖的 run1 user 移出路径
    expect(history.some((m) => textOf(m).includes("ALPHA_FIRST_USER"))).toBe(false);
    // summary 进入路径
    expect(history.some((m) => textOf(m).includes("COMPACTED_PARTIAL"))).toBe(true);
    // 未被覆盖的近端 tail（run1 assistant）仍在路径上，未被静默丢弃
    expect(history.some((m) => textOf(m).includes(run1AssistantText))).toBe(true);
    // run2 的内容也在
    expect(history.some((m) => textOf(m).includes("BETA_SECOND_USER"))).toBe(true);
  });
});
