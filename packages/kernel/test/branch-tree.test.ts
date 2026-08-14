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
    // 展示历史不受 LLM 上下文压缩影响，仍保留真实消息链。
    expect(session.getDisplayHistory().some((m) => textOf(m).includes("ALPHA_FIRST_USER"))).toBe(true);
    // summary 进入路径
    expect(history.some((m) => textOf(m).includes("COMPACTED_PARTIAL"))).toBe(true);
    // 未被覆盖的近端 tail（run1 assistant）仍在路径上，未被静默丢弃
    expect(history.some((m) => textOf(m).includes(run1AssistantText))).toBe(true);
    // run2 的内容也在
    expect(history.some((m) => textOf(m).includes("BETA_SECOND_USER"))).toBe(true);
  });
});

describe("compact-on-tree —— Q3：压缩不误伤共享 tail 节点的兄弟分支", () => {
  it("主线压缩（tail[0] 为共享节点）后，从该共享节点分叉的兄弟分支历史完整不被截断", async () => {
    const kernel = new Kernel({
      workDir,
      manifest: {
        plugins: [
          { port: "FileSystemPort", package: "@helios/fs-node" },
          { port: "CompactStrategyPort", package: fixture("mockCompactOnceAll.ts") },
          { port: "LLMProvider", package: fixture("mockLlmCounter.ts") },
        ],
      },
      logger: silent,
    });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    // 建主线：U1_MARK / U2 —— 两 run，路径达 4 条（下一 run 起点触发一次性压缩）。
    await session.sendMessage("U1_MARK");
    await session.sendMessage("U2");
    const afterTwo = session.getHistory();
    const sharedNodeId = afterTwo[afterTwo.length - 1].id; // = a2，将成为压缩后保留的 tail[0]（共享节点）

    // 第三个 run 起点 path 长度=4 → 一次性压缩：覆盖 {u1,a1,u2}，保留 a2（tail[0]=共享节点）。
    await session.sendMessage("U3");
    const mainLeafId = session.getHistory()[session.getHistory().length - 1].id;
    const mainHistory = session.getHistory();
    // 主线视图：summary 在、被覆盖的 U1_MARK 移出
    expect(mainHistory.some((m) => textOf(m).includes("COMPACTED_ONCE"))).toBe(true);
    expect(mainHistory.some((m) => textOf(m).includes("U1_MARK"))).toBe(false);

    // 从共享节点 a2 分叉出兄弟分支（该分支自身不触发压缩：一次性策略已用尽）。
    session.fork(sharedNodeId);
    await session.sendMessage("SIBLING_LEAF");
    const sibLeafId = session.getHistory()[session.getHistory().length - 1].id;

    // 关键断言：兄弟分支未参与压缩，压缩前的早期历史（U1_MARK）必须仍在，且不含 summary。
    const sibHistory = session.getHistory();
    expect(sibHistory.some((m) => textOf(m).includes("U1_MARK"))).toBe(true);
    expect(sibHistory.some((m) => textOf(m).includes("SIBLING_LEAF"))).toBe(true);
    expect(sibHistory.some((m) => textOf(m).includes("COMPACTED_ONCE"))).toBe(false);

    // 切回主线仍是压缩视图，互不串味。
    session.switchBranch(mainLeafId);
    const backMain = session.getHistory();
    expect(backMain.some((m) => textOf(m).includes("COMPACTED_ONCE"))).toBe(true);
    expect(backMain.some((m) => textOf(m).includes("U1_MARK"))).toBe(false);
    void sibLeafId;
  });
});

describe("compact-on-tree —— 压缩记录跨 resume 持久化", () => {
  it("resume 后仍是压缩视图（summary 在、被覆盖内容不在），而非全量历史", async () => {
    const buildManifest = (): Manifest => ({
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "CompactStrategyPort", package: fixture("mockCompactPartial.ts") },
        { port: "LLMProvider", package: fixture("mockLlmCounter.ts") },
      ],
    });

    const k1 = new Kernel({ workDir, manifest: buildManifest(), logger: silent });
    await k1.start();
    const s1 = k1.createSession({ askQuestion: noAsk });
    await s1.sendMessage("ALPHA_U1");
    await s1.sendMessage("BETA_U2"); // run2 起点触发部分覆盖压缩：覆盖 {u1}，保留 a1
    const sid = s1.id;
    // 压缩已生效：ALPHA_U1 移出、summary 在
    expect(s1.getHistory().some((m) => textOf(m).includes("ALPHA_U1"))).toBe(false);
    expect(s1.getHistory().some((m) => textOf(m).includes("COMPACTED_PARTIAL"))).toBe(true);

    // 全新 Kernel resume
    const k2 = new Kernel({ workDir, manifest: buildManifest(), logger: silent });
    await k2.start();
    const s2 = await k2.resumeSession(sid, { askQuestion: noAsk });

    const restored = s2.getHistory();
    // 压缩视图被恢复：被覆盖的 ALPHA_U1 仍不在路径、summary 仍在（未回退成全量历史）
    expect(restored.some((m) => textOf(m).includes("ALPHA_U1"))).toBe(false);
    expect(restored.some((m) => textOf(m).includes("COMPACTED_PARTIAL"))).toBe(true);
    expect(restored.some((m) => textOf(m).includes("BETA_U2"))).toBe(true);
  });
});
