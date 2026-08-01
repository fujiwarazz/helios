import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 真实 e2e：拉起 CLI 子进程，接本地 Anthropic 兼容网关（127.0.0.1:8788），跑一轮 agent loop。
// 默认跳过（不依赖网络/服务）；设 HELIOS_LLM_E2E=1 时运行。
const ENABLED = process.env.HELIOS_LLM_E2E === "1";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts");
const ENDPOINT = process.env.HELIOS_LLM_BASE_URL ?? "http://127.0.0.1:8788";
const MODEL = process.env.HELIOS_LLM_MODEL ?? "Claude-4.8-opus";

function runCli(
  workDir: string,
  message: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI_ENTRY, "--message", message], {
      cwd: workDir,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-e2e-"));
  const manifest = {
    plugins: [
      { port: "FileSystemPort", package: "@helios/fs-node" },
      {
        port: "LLMProvider",
        package: "@helios/llm-anthropic",
        options: { baseURL: ENDPOINT, apiKey: "local", model: MODEL },
      },
    ],
  };
  await writeFile(join(workDir, "helios.config.json"), JSON.stringify(manifest, null, 2), "utf8");
  return async () => rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("CLI e2e —— 真实模型 agent loop", () => {
  it(
    "对话可流式返回文本",
    async () => {
      const { code, stdout } = await runCli(workDir, "用一句话介绍你自己");
      console.log("\n===== CLI transcript (chat) =====\n" + stdout);
      expect(code).toBe(0);
      expect(stdout).toContain("helios ›");
      // helios › 之后应有非空助手输出
      const after = stdout.split("helios ›")[1] ?? "";
      expect(after.trim().length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "工具循环：让模型 Write 一个文件再 Read 回来",
    async () => {
      const msg =
        "请调用 Write 工具创建文件 note.txt，内容为 hello-helios；创建后调用 Read 工具读回它确认。";
      const { code, stdout } = await runCli(workDir, msg);
      console.log("\n===== CLI transcript (tool loop) =====\n" + stdout);
      expect(code).toBe(0);
      expect(stdout).toContain("调用工具");
      const content = await readFile(join(workDir, "note.txt"), "utf8");
      expect(content).toContain("hello-helios");
    },
    180_000,
  );
});
