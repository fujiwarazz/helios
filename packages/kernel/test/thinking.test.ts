import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Logger,
  AskQuestionRequest,
  AskQuestionResponse,
  ContentBlock,
} from "@helios/ports";
import { Kernel, type Manifest } from "../src/index";

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noAsk = async (_r: AskQuestionRequest): Promise<AskQuestionResponse> => ({ answers: ["允许"] });

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-thinking-"));
  return async () => rm(workDir, { recursive: true, force: true });
});

async function runOnce(llmFixture: string) {
  const manifest: Manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      { port: "LLMProvider", package: fixture(llmFixture) },
    ],
  };
  const kernel = new Kernel({ workDir, manifest, logger: silent });
  await kernel.start();
  const session = kernel.createSession({ askQuestion: noAsk });
  return session.sendMessage("go");
}

describe("thinking 在 session 层的累积与判空", () => {
  it("thinking + text → assistant 内容含 thinking 块（带 signature）且置于 text 之前", async () => {
    const newMessages = await runOnce("mockLlmThinking.ts");
    const assistant = newMessages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const content = assistant!.content as ContentBlock[];
    expect(content[0]).toEqual({ type: "thinking", thinking: "let me think", signature: "sig-1" });
    expect(content[1]).toEqual({ type: "text", text: "the answer" });
  });

  it("thinking-only 轮不计入有效正文，不入历史", async () => {
    const newMessages = await runOnce("mockLlmThinkingOnly.ts");
    // 只有 user 消息，没有 assistant（thinking-only 被判为空轮）
    expect(newMessages.some((m) => m.role === "assistant")).toBe(false);
    expect(newMessages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
