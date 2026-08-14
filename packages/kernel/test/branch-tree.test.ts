import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse, Message } from "@helios/ports";
import { Kernel, SessionBusyError, type Manifest } from "../src/index";
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
    await session.fork(branchPointId);
    expect(events.some((e) => e.type === "head_changed" && e.headId === branchPointId)).toBe(true);
    await session.sendMessage("ALTBRANCH");
    const branchB = session.getHistory();
    expect(branchB.some((m) => textOf(m).includes("ALTBRANCH"))).toBe(true);
    expect(branchB.some((m) => textOf(m).includes("MAINLINE"))).toBe(false); // 不含主线分支内容

    // 旧主线分支未被删除，可切回
    await session.switchBranch(mainLeafId);
    const backToMain = session.getHistory();
    expect(backToMain.some((m) => textOf(m).includes("MAINLINE"))).toBe(true);
    expect(backToMain.some((m) => textOf(m).includes("ALTBRANCH"))).toBe(false);

    // 两条分支都在（含被 fork 出的旧叶子祖先），listBranches 至少枚举出两个叶子
    const leaves = session.listBranches().map((b) => b.leafId);
    expect(leaves).toContain(mainLeafId);
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    // 当前分支被标出，供 UI 区分
    expect(session.listBranches().filter((b) => b.isCurrent)).toHaveLength(1);
    void oldLeafId;
  });

  it("fork 不存在的节点抛错", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("x");
    await expect(session.fork("nope")).rejects.toThrow(/node 不存在/);
  });
});

describe("compact-on-tree —— 部分覆盖不丢近端上下文", () => {
  it("summary 只覆盖前缀时，未覆盖的近端节点作为 summary 的祖先仍在路径上", async () => {
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
    await session.fork(sharedNodeId);
    await session.sendMessage("SIBLING_LEAF");
    const sibLeafId = session.getHistory()[session.getHistory().length - 1].id;

    // 关键断言：兄弟分支未参与压缩，压缩前的早期历史（U1_MARK）必须仍在，且不含 summary。
    const sibHistory = session.getHistory();
    expect(sibHistory.some((m) => textOf(m).includes("U1_MARK"))).toBe(true);
    expect(sibHistory.some((m) => textOf(m).includes("SIBLING_LEAF"))).toBe(true);
    expect(sibHistory.some((m) => textOf(m).includes("COMPACTED_ONCE"))).toBe(false);

    // 切回主线仍是压缩视图，互不串味。
    await session.switchBranch(mainLeafId);
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
    // 展示历史仍是物理原链（summary 不进 UI）
    expect(s2.getDisplayHistory().some((m) => textOf(m).includes("ALPHA_U1"))).toBe(true);
    expect(s2.getDisplayHistory().some((m) => textOf(m).includes("COMPACTED_PARTIAL"))).toBe(false);
  });
});

describe("消息树 —— 分支跨 resume 存活", () => {
  it("resume 后旧分支仍可枚举并切回（parentId 原样落盘，不被线性化）", async () => {
    const k1 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k1.start();
    const s1 = k1.createSession({ askQuestion: noAsk });
    const sid = s1.id;

    await s1.sendMessage("第一轮");
    const branchPointId = s1.getHistory().slice(-1)[0].id;
    await s1.sendMessage("MAINLINE");
    const mainLeafId = s1.getHistory().slice(-1)[0].id;

    await s1.fork(branchPointId);
    await s1.sendMessage("ALTBRANCH");
    const altLeafId = s1.getHistory().slice(-1)[0].id;
    expect(s1.listBranches()).toHaveLength(2);

    // 全新 Kernel resume：两条分支都必须还在
    const k2 = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await k2.start();
    const s2 = await k2.resumeSession(sid, { askQuestion: noAsk });

    const leaves = s2.listBranches().map((b) => b.leafId);
    expect(leaves).toContain(mainLeafId);
    expect(leaves).toContain(altLeafId);
    // HEAD 落在 fork 后的分支上（磁盘记录了 fork，不是简单回到日志末端）
    expect(s2.getHistory().some((m) => textOf(m).includes("ALTBRANCH"))).toBe(true);
    expect(s2.getHistory().some((m) => textOf(m).includes("MAINLINE"))).toBe(false);

    // 切回主线仍完整
    await s2.switchBranch(mainLeafId);
    expect(s2.getHistory().some((m) => textOf(m).includes("MAINLINE"))).toBe(true);
    expect(s2.getHistory().some((m) => textOf(m).includes("ALTBRANCH"))).toBe(false);
  });

  it("分支预览取分叉点之后的第一条消息，而非叶子（叶子是 assistant 回复，多分支常常一样）", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    await session.sendMessage("共同前缀");
    const branchPointId = session.getHistory().slice(-1)[0].id;
    await session.sendMessage("走方案甲");
    await session.fork(branchPointId);
    await session.sendMessage("走方案乙");

    const previews = session.listBranches().map((b) => b.preview);
    // mock LLM 两条分支的 assistant 回复完全相同；能区分分支的只有用户那条分叉消息
    expect(previews).toHaveLength(2);
    expect(previews.some((p) => p.includes("走方案甲"))).toBe(true);
    expect(previews.some((p) => p.includes("走方案乙"))).toBe(true);
  });
});

describe("消息树 —— run 进行中禁止移动 HEAD", () => {
  /**
   * 这是数据损坏防护，不是保守起见：sendMessage 内部有大量 await，并发切分支会改掉 headId，
   * 于是正在生成的 assistant 消息被 appendNode 挂到新分支上（却是用旧分支上下文生成的），
   * 同一 turn 的 user/assistant 还会分裂到两条树链。rollback 更甚（还会 restore 工作区文件）。
   */
  it("run 飞行中 fork/switchBranch/rollback 一律拒绝，且树不被分裂", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });

    await session.sendMessage("第一轮");
    const branchPointId = session.getHistory().slice(-1)[0].id;

    // 不 await：让 run 处于飞行中（runInFlight 在第一个 await 之前就同步置位）。
    // 必须在 finally 里 await，否则断言失败会留下悬空 run，它随后会在被清理掉的 workDir 上写盘。
    const running = session.sendMessage("第二轮");
    try {
      await expect(session.fork(branchPointId)).rejects.toThrow(SessionBusyError);
      await expect(session.switchBranch(branchPointId)).rejects.toThrow(/生成过程中不可用/);
      await expect(session.rollback(`${session.id}-0-0`)).rejects.toThrow(SessionBusyError);
    } finally {
      await running;
    }

    // 核心不变量：三次拒绝没有产生任何分支，本 run 的 user/assistant 仍在同一条链上。
    expect(session.listBranches()).toHaveLength(1);
    const display = session.getDisplayHistory();
    expect(display.some((m) => textOf(m).includes("第二轮"))).toBe(true);
    // 链式连续：每个非根节点的 parent 都是它在展示历史里的前一个节点
    for (let i = 1; i < display.length; i++) {
      expect(display[i].parentId).toBe(display[i - 1].id);
    }

    // run 结束后恢复可用
    await session.fork(branchPointId);
    expect(session.getHistory().slice(-1)[0].id).toBe(branchPointId);
  });

  it("run 被 cancel 打断后闸门也会复位，不会永久卡住切分支", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const session = kernel.createSession({ askQuestion: noAsk });
    await session.sendMessage("第一轮");
    const branchPointId = session.getHistory().slice(-1)[0].id;

    const running = session.sendMessage("会被打断");
    session.cancel();
    await running;

    // runInFlight 在 finally 里复位，不受 run 是否优雅收尾影响
    await expect(session.fork(branchPointId)).resolves.toBeUndefined();
  });
});
