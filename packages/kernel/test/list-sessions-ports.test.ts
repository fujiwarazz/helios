import { describe, it, expect, beforeEach } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
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

const manifest = (): Manifest => ({
  plugins: [
    { port: "FileSystemPort", package: "@helios/fs-node" },
    { port: "CheckpointPort", package: "@helios/checkpoint-fs" },
    { port: "LLMProvider", package: fixture("mockLlmTextOnly.ts") },
  ],
});

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-list-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("kernel listSessions / listPorts", () => {
  it("无会话时 listSessions 返回空数组", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    expect(await kernel.listSessions()).toEqual([]);
  });

  it("跑过会话后 listSessions 能读回 meta,按 updatedAt 倒序", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const s1 = kernel.createSession({ askQuestion: noAsk });
    await s1.sendMessage("第一条");
    const s2 = kernel.createSession({ askQuestion: noAsk });
    await s2.sendMessage("第二条");

    const list = await kernel.listSessions();
    expect(list.length).toBe(2);
    // 每条都有 id/updatedAt;倒序(晚更新在前)
    expect(list.every((m) => typeof m.id === "string")).toBe(true);
    expect(list[0].updatedAt).toBeGreaterThanOrEqual(list[1].updatedAt);
    expect(list.map((m) => m.id)).toContain(s1.id);
    expect(list.map((m) => m.id)).toContain(s2.id);
  });

  it("从独立 sessionDataRoot 列出会话", async () => {
    const sessionDataRoot = await mkdtemp(join(tmpdir(), "helios-list-state-"));
    try {
      const kernel = new Kernel({
        workDir,
        sessionDataRoot,
        manifest: manifest(),
        logger: silent,
      });
      await kernel.start();
      const session = kernel.createSession({ askQuestion: noAsk });
      await session.sendMessage("global state");

      expect((await kernel.listSessions()).map((meta) => meta.id)).toEqual([session.id]);
      await expect(
        access(join(workDir, ".helios", "sessions", session.id)),
      ).rejects.toBeDefined();
    } finally {
      await rm(sessionDataRoot, { recursive: true, force: true });
    }
  });

  it("listPorts 按 provider 聚合工具,含 builtin", async () => {
    const kernel = new Kernel({ workDir, manifest: manifest(), logger: silent });
    await kernel.start();
    const ports = kernel.listPorts();
    expect(ports.length).toBeGreaterThan(0);
    // 六件套内建工具归到 builtin
    const builtin = ports.find((p) => p.provider === "builtin");
    expect(builtin).toBeTruthy();
    expect(builtin!.tools.length).toBeGreaterThan(0);
    expect(ports.every((p) => p.enabled === true)).toBe(true);
  });
});
