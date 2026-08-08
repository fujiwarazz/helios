import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-cancel-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

describe("Session.cancel() 中断当前 run", () => {
  it("cancel 后 run 迅速收敛，远不到 maxTurns，且不抛异常", async () => {
    const manifest: Manifest = {
      plugins: [
        { port: "FileSystemPort", package: "@helios/fs-node" },
        { port: "LLMProvider", package: fixture("mockLlmCancelLoop.ts") },
        { port: "CapabilityProvider", package: fixture("mockCapability.ts") },
      ],
    };
    const kernel = new Kernel({ workDir, manifest, logger: silent });
    await kernel.start();
    // maxTurns 显式设小以缩短「未中断兜底」时长，但仍远大于中断后应有轮数。
    const session = kernel.createSession({ askQuestion: noAsk, maxTurns: 20 });

    const p = session.sendMessage("一直循环");
    setTimeout(() => session.cancel(), 30);
    const newMessages = await p; // 不应挂死、不应抛出

    const assistantTurns = newMessages.filter((m) => m.role === "assistant").length;
    expect(assistantTurns).toBeGreaterThan(0);
    expect(assistantTurns).toBeLessThan(20); // 被 cancel 打断，未跑满
  });
});
