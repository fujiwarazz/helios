import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger, AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";
import type { AgentEvent } from "../src/events";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-p1-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

async function runDelegateWith(multiAgentPackage: string): Promise<string> {
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "MultiAgentPort", package: multiAgentPackage },
      { port: "CapabilityProvider", package: fixture("delegatorCapability.ts") },
      { port: "LLMProvider", package: fixture("mockLlmDelegate.ts") },
    ],
  };
  const kernel = new Kernel({ workDir, manifest, logger: silent });
  await kernel.start();
  const events: AgentEvent[] = [];
  const session = kernel.createSession({ askQuestion: noAsk });
  session.on((e) => events.push(e));
  await session.sendMessage("go");
  const end = events.find((e) => e.type === "tool_execution_end");
  return (end as Extract<AgentEvent, { type: "tool_execution_end" }>).output as string;
}

describe("可插拔性 —— 替换 MultiAgentPort 实现，kernel 与 Task 工具零改动", () => {
  it("官方 teams-mailbox 与内存 mock 实现产出完全一致", async () => {
    const viaMailbox = await runDelegateWith("@helios/teams-mailbox");
    const viaMock = await runDelegateWith(fixture("mockMultiAgent.ts"));
    expect(viaMailbox).toBe("delegated to worker");
    expect(viaMock).toBe("delegated to worker");
    expect(viaMailbox).toBe(viaMock);
  });
});
