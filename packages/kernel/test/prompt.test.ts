import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, KernelContext, PortRegistry } from "@helios/ports";
import * as fsNode from "@helios/fs-node";
import {
  BASE_SYSTEM_PROMPT,
  buildEnvBlock,
  loadProjectInstructions,
  renderProjectInstructions,
  Kernel,
} from "../src/index";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

let workDir: string;
let globalDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-prompt-"));
  globalDir = await mkdtemp(join(tmpdir(), "helios-prompt-global-"));
  return async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  };
});

function fileSystemFor(dir: string) {
  const ports = {} as PortRegistry;
  const ctx: KernelContext = { workDir: dir, logger: silent, ports };
  return fsNode.create(ctx);
}

describe("BASE_SYSTEM_PROMPT", () => {
  it("包含各行为规范 section，且只提 helios 真实具备的能力", () => {
    for (const heading of [
      "# Doing tasks",
      "# Using your tools",
      "# Executing actions with care",
      "# Tone and style",
    ]) {
      expect(BASE_SYSTEM_PROMPT).toContain(heading);
    }
    // caps__ 是 capability-fs 真实注册的工具前缀，可以提。
    expect(BASE_SYSTEM_PROMPT).toContain("caps__");
    // helios 没有这些机制，提了就是指向不存在的能力。
    expect(BASE_SYSTEM_PROMPT).not.toContain("plan mode");
    expect(BASE_SYSTEM_PROMPT).not.toContain("system-reminder");
  });
});

describe("buildEnvBlock", () => {
  it("输出闭合的 env 块，含 workDir/平台", () => {
    const block = buildEnvBlock({
      workDir: "/tmp/demo",
      isGitRepo: true,
      platform: "darwin",
      osVersion: "25.4.0",
    });
    expect(block.startsWith("<env>")).toBe(true);
    expect(block.endsWith("</env>")).toBe(true);
    expect(block).toContain("Working directory: /tmp/demo");
    expect(block).toContain("Is a git repository: yes");
    expect(block).toContain("Platform: darwin");
    expect(block).toContain("OS version: 25.4.0");
  });

  it("不含当前日期：system 前缀每会话冻结，放进去跨天就是个自信的错值", () => {
    const block = buildEnvBlock({
      workDir: "/tmp/demo",
      isGitRepo: true,
      platform: "darwin",
      osVersion: "25.4.0",
    });
    expect(block.toLowerCase()).not.toContain("date");
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("非 git 仓库渲染为 no", () => {
    const block = buildEnvBlock({
      workDir: "/tmp/demo",
      isGitRepo: false,
      platform: "linux",
      osVersion: "6.1",
    });
    expect(block).toContain("Is a git repository: no");
  });
});

describe("loadProjectInstructions", () => {
  it("没有任何指令文件时返回空，渲染成空串", async () => {
    const files = await loadProjectInstructions({
      fileSystem: fileSystemFor(workDir),
      globalDir,
    });
    expect(files).toEqual([]);
    expect(renderProjectInstructions(files)).toBe("");
  });

  it("按 broad → specific 顺序加载全局 AGENTS.md、workDir AGENTS.md 与 HELIOS.md", async () => {
    await writeFile(join(globalDir, "AGENTS.md"), "global rule", "utf8");
    await writeFile(join(workDir, "AGENTS.md"), "repo rule", "utf8");
    await writeFile(join(workDir, "HELIOS.md"), "helios rule", "utf8");
    const files = await loadProjectInstructions({
      fileSystem: fileSystemFor(workDir),
      globalDir,
    });
    expect(files.map((f) => f.path)).toEqual([
      join(globalDir, "AGENTS.md"),
      "AGENTS.md",
      "HELIOS.md",
    ]);
    expect(files.map((f) => f.content)).toEqual(["global rule", "repo rule", "helios rule"]);
  });

  it("globalDir 传空串时跳过全局加载", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "repo rule", "utf8");
    const files = await loadProjectInstructions({
      fileSystem: fileSystemFor(workDir),
      globalDir: "",
    });
    expect(files.map((f) => f.path)).toEqual(["AGENTS.md"]);
  });

  it("跳过空白内容的指令文件", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "   \n\n", "utf8");
    const files = await loadProjectInstructions({
      fileSystem: fileSystemFor(workDir),
      globalDir,
    });
    expect(files).toEqual([]);
  });
});

describe("renderProjectInstructions", () => {
  it("每个文件包一层带 path 属性的 project_instructions", () => {
    const rendered = renderProjectInstructions([
      { path: "AGENTS.md", content: "use pnpm" },
      { path: "HELIOS.md", content: "no bash" },
    ]);
    expect(rendered).toContain("<project_context>");
    expect(rendered).toContain('<project_instructions path="AGENTS.md">\nuse pnpm\n</project_instructions>');
    expect(rendered).toContain('<project_instructions path="HELIOS.md">\nno bash\n</project_instructions>');
    expect(rendered.endsWith("</project_context>")).toBe(true);
    // AGENTS.md 必须排在 HELIOS.md 之前（broad → specific 顺序由调用方保证，渲染不得重排）。
    expect(rendered.indexOf("use pnpm")).toBeLessThan(rendered.indexOf("no bash"));
  });
});

describe("Kernel 系统提示词装配", () => {
  const manifest = {
    plugins: [
      { port: "FileSystemPort" as const, package: "@helios/fs-node" },
      { port: "LLMProvider" as const, package: fixture("mockLlmEchoSystem.ts") },
    ],
  };

  it("顺序为 base → project_context → env，且三部分都在", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "repo rule", "utf8");
    const system = await systemSeenByProvider({ globalInstructionDir: "" });
    expect(system).toContain("# Doing tasks");
    expect(system).toContain("repo rule");
    expect(system).toContain("<env>");
    expect(system.indexOf("# Doing tasks")).toBeLessThan(system.indexOf("<project_context>"));
    expect(system.indexOf("<project_context>")).toBeLessThan(system.indexOf("<env>"));
  });

  it("无指令文件时不留空的 project_context 块", async () => {
    const system = await systemSeenByProvider({ globalInstructionDir: "" });
    expect(system).not.toContain("<project_context>");
    expect(system).toContain("<env>");
  });

  it("opts.system 覆盖基础正文，但 env 与项目指令照旧追加", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "repo rule", "utf8");
    const system = await systemSeenByProvider({
      globalInstructionDir: "",
      system: "custom base",
    });
    expect(system.startsWith("custom base")).toBe(true);
    expect(system).not.toContain("# Doing tasks");
    expect(system).toContain("repo rule");
    expect(system).toContain("<env>");
  });

  it("识别 workDir 是否为 git 仓库", async () => {
    await mkdir(join(workDir, ".git"), { recursive: true });
    const system = await systemSeenByProvider({ globalInstructionDir: "" });
    expect(system).toContain("Is a git repository: yes");
  });

  /**
   * 跑一轮真实对话，读回 provider 实际收到的 system。
   * mockLlmEchoSystem 把 opts.system 原样当文本输出，所以助手回复即请求里的 system 前缀。
   */
  async function systemSeenByProvider(
    extra: { globalInstructionDir?: string; system?: string },
  ): Promise<string> {
    const kernel = new Kernel({ workDir, manifest, logger: silent, ...extra });
    await kernel.start();
    try {
      const session = kernel.createSession({ askQuestion: async () => ({ answers: [] }) });
      await session.sendMessage("hi");
      const last = session.getHistory().at(-1)!;
      return typeof last.content === "string"
        ? last.content
        : last.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } finally {
      await kernel.dispose();
    }
  }
});

function fixture(name: string): string {
  return join(import.meta.dirname, "fixtures", name);
}
