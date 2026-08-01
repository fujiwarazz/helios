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

async function runAndRollback(checkpointPackage: string): Promise<{
  createdBeforeRollback: boolean;
  existsAfterRollback: boolean;
  preservedContent: string;
  historyLen: number;
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
  const session = kernel.createSession({ askQuestion: noAsk });
  await session.sendMessage("写个文件");

  const createdBeforeRollback = await exists(join(workDir, "roll.txt"));

  // 回溯到该 run 的第 0 个 turn（Write 发生在此 turn），文件应被还原为不存在
  await session.rollback(`${session.id}-0-0`);

  return {
    createdBeforeRollback,
    existsAfterRollback: await exists(join(workDir, "roll.txt")),
    preservedContent: await readFile(join(workDir, "keep.txt"), "utf8"),
    historyLen: session.getHistory().length,
  };
}

describe("P2 Turn 回溯 —— CheckpointPort 从 fs 换成 git，Session 与调用方零改动", () => {
  it("checkpoint-fs：回溯还原文件并截断历史", async () => {
    const r = await runAndRollback("@helios/checkpoint-fs");
    expect(r.createdBeforeRollback).toBe(true);
    expect(r.existsAfterRollback).toBe(false);
    expect(r.preservedContent).toBe("keep-me");
    expect(r.historyLen).toBe(1); // 仅保留用户消息
  });

  it("checkpoint-git：影子 git 快照行为与 fs 完全一致", async () => {
    const r = await runAndRollback("@helios/checkpoint-git");
    expect(r.createdBeforeRollback).toBe(true);
    expect(r.existsAfterRollback).toBe(false);
    expect(r.preservedContent).toBe("keep-me");
    expect(r.historyLen).toBe(1);
  });
});
