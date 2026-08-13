import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "@helios/kernel";
import { WorkspacePaths } from "@helios/workspace";
import { parseCliOptions } from "../src/options";
import { openCliWorkspace } from "../src/workspaceRuntime";

// 真实 e2e：拉起 CLI 子进程，接本地 Anthropic 兼容网关（127.0.0.1:8788），跑一轮 agent loop。
// 默认跳过（不依赖网络/服务）；设 HELIOS_LLM_E2E=1 时运行。
const ENABLED = process.env.HELIOS_LLM_E2E === "1";
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts");
const ENDPOINT = process.env.HELIOS_LLM_BASE_URL ?? "http://127.0.0.1:8788";
const MODEL = process.env.HELIOS_LLM_MODEL ?? "Claude-4.8-opus";
const require = createRequire(import.meta.url);
const MOCK_MANIFEST: Manifest = {
  plugins: [
    { port: "FileSystemPort", package: require.resolve("@helios/fs-node") },
    {
      port: "LLMProvider",
      package: fileURLToPath(
        new URL("../../../packages/kernel/test/fixtures/mockLlmTextOnly.ts", import.meta.url),
      ),
    },
  ],
};

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

describe("CLI workspace flags", () => {
  it("parses each Code source and the worktree strategy", () => {
    expect(parseCliOptions(["--code", ".", "--worktree", "--message", "hello"])).toEqual({
      codePath: ".",
      message: "hello",
      worktree: true,
    });
    expect(parseCliOptions(["--clone", "git@github.com:org/repo.git"])).toEqual({
      cloneUrl: "git@github.com:org/repo.git",
      worktree: false,
    });
    expect(parseCliOptions(["--workspace", "ws_1"])).toEqual({
      workspaceId: "ws_1",
      worktree: false,
    });
  });

  it("allows a legacy root only when resuming", () => {
    expect(
      parseCliOptions(["--resume", "sess_1", "--legacy-workdir", "/tmp/legacy"]),
    ).toEqual({
      resume: "sess_1",
      legacyWorkDir: "/tmp/legacy",
      worktree: false,
    });
    expect(() => parseCliOptions(["--legacy-workdir", "/tmp/legacy"])).toThrow(
      /legacy-workdir.*resume/i,
    );
  });

  it("rejects conflicting session sources and invalid worktree use", () => {
    expect(() => parseCliOptions(["--resume", "sess_1", "--code", "."])).toThrow(
      /resume.*code/i,
    );
    expect(() => parseCliOptions(["--code", ".", "--clone", "git@example:repo.git"])).toThrow(
      /only one/i,
    );
    expect(() => parseCliOptions(["--worktree"])).toThrow(/worktree.*code/i);
  });

  it("rejects unknown, repeated, and valueless flags", () => {
    expect(() => parseCliOptions(["--unknown"])).toThrow(/unknown option/i);
    expect(() => parseCliOptions(["--code"])).toThrow(/requires a value/i);
    expect(() => parseCliOptions(["--message", "one", "--message", "two"])).toThrow(
      /specified more than once/i,
    );
  });
});

describe("CLI workspace runtime", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates a managed Chat workspace and persists its session outside the repository", async () => {
    const dataRoot = await temporaryRoot("helios-cli-data-");
    const cwd = await temporaryRoot("helios-cli-cwd-");
    const runtime = await openCliWorkspace({
      cli: { worktree: false },
      cwd,
      dataRoot,
      manifest: MOCK_MANIFEST,
      askQuestion: async () => ({ answers: [] }),
    });
    try {
      await runtime.bound.session.sendMessage("hello");
      expect(runtime.bound.binding.mode).toBe("chat");
      expect(runtime.bound.materialized.primaryDir).toContain(
        join(dataRoot, "managed-workspaces"),
      );
      expect(await readFile(new WorkspacePaths(dataRoot).sessionRecord(runtime.bound.session.id), "utf8"))
        .toContain('"schemaVersion": 1');
    } finally {
      await runtime.close();
    }
  });

  it("opens a local repository directly and resumes the same binding from another cwd", async () => {
    const dataRoot = await temporaryRoot("helios-cli-data-");
    const repository = await createGitRepository(await temporaryRoot("helios-cli-repo-"));
    const first = await openCliWorkspace({
      cli: { codePath: repository, worktree: false },
      cwd: repository,
      dataRoot,
      manifest: MOCK_MANIFEST,
      askQuestion: async () => ({ answers: [] }),
    });
    const sessionId = first.bound.session.id;
    const workspaceId = first.bound.binding.workspaceId;
    try {
      await first.bound.session.sendMessage("hello");
      expect(first.bound.materialized.primaryDir).toBe(await realpath(repository));
    } finally {
      await first.close();
    }

    const unrelatedCwd = await temporaryRoot("helios-cli-other-");
    const resumed = await openCliWorkspace({
      cli: { resume: sessionId, worktree: false },
      cwd: unrelatedCwd,
      dataRoot,
      manifest: MOCK_MANIFEST,
      askQuestion: async () => ({ answers: [] }),
    });
    try {
      expect(resumed.bound.binding.workspaceId).toBe(workspaceId);
      expect(resumed.bound.materialized.primaryDir).toBe(await realpath(repository));
    } finally {
      await resumed.close();
    }
  });

  it("creates an isolated worktree branch for --worktree", async () => {
    const dataRoot = await temporaryRoot("helios-cli-data-");
    const repository = await createGitRepository(await temporaryRoot("helios-cli-repo-"));
    const runtime = await openCliWorkspace({
      cli: { codePath: repository, worktree: true },
      cwd: repository,
      dataRoot,
      manifest: MOCK_MANIFEST,
      askQuestion: async () => ({ answers: [] }),
    });
    try {
      expect(runtime.bound.binding.roots[0]?.strategy).toBe("worktree");
      expect(runtime.bound.materialized.primaryDir).not.toBe(await realpath(repository));
      expect(
        (await runGit(["branch", "--show-current"], runtime.bound.materialized.primaryDir)).trim(),
      ).toMatch(/^helios\/mat_/);
    } finally {
      await runtime.close();
    }
  });

  it("does not create a SessionRecord when Clone fails", async () => {
    const dataRoot = await temporaryRoot("helios-cli-data-");
    await expect(
      openCliWorkspace({
        cli: { cloneUrl: "https://127.0.0.1:1/repo.git", worktree: false },
        cwd: workDir,
        dataRoot,
        manifest: MOCK_MANIFEST,
        askQuestion: async () => ({ answers: [] }),
        gitTimeoutMs: 1_000,
      }),
    ).rejects.toThrow();
    await expect(readFile(join(dataRoot, "sessions", "missing", "session.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  async function temporaryRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(path);
    return path;
  }
});

describe("CLI process workspace entry", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("returns exit 2 for conflicting flags before starting a Kernel", async () => {
    const cwd = await temporaryRoot("helios-cli-process-");
    const result = await runCliArgs(cwd, ["--resume", "sess_1", "--code", "."]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/resume.*code/i);
  });

  it("runs Code direct through the workspace platform", async () => {
    const repository = await createGitRepository(await temporaryRoot("helios-cli-process-repo-"));
    const dataRoot = await temporaryRoot("helios-cli-process-data-");
    await writeFile(
      join(repository, "helios.config.json"),
      JSON.stringify(MOCK_MANIFEST, null, 2),
      "utf8",
    );

    const result = await runCliArgs(
      repository,
      ["--code", repository, "--message", "hello"],
      { HELIOS_DATA_ROOT: dataRoot },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Code workspace");
    const sessionIds = await readdir(join(dataRoot, "sessions"));
    expect(sessionIds).toHaveLength(1);
    const record = JSON.parse(
      await readFile(new WorkspacePaths(dataRoot).sessionRecord(sessionIds[0]!), "utf8"),
    ) as { binding: { mode: string; roots: Array<{ strategy: string }> } };
    expect(record.binding).toMatchObject({ mode: "code", roots: [{ strategy: "direct" }] });
  });

  async function temporaryRoot(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(path);
    return path;
  }
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

async function createGitRepository(path: string): Promise<string> {
  await runGit(["init", "-b", "main"], path);
  await runGit(["config", "user.email", "helios@example.com"], path);
  await runGit(["config", "user.name", "Helios Test"], path);
  await writeFile(join(path, "README.md"), "initial\n", "utf8");
  await runGit(["add", "README.md"], path);
  await runGit(["commit", "-m", "initial"], path);
  return await realpath(path);
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(error || `git exited with ${String(code)}`));
    });
  });
}

function runCliArgs(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI_ENTRY, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
