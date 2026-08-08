import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@helios/ports";
import { loadHookConfig, toHookBindings, type HookConfigEntry } from "../src/hookConfigLoader";

function capturingLogger(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: { debug() {}, info() {}, warn: (...a) => warns.push(a.join(" ")), error() {} },
  };
}

async function writeHooksFile(dir: string, body: unknown): Promise<void> {
  await mkdir(join(dir, ".helios"), { recursive: true });
  await writeFile(join(dir, ".helios", "hooks.json"), JSON.stringify(body), "utf8");
}

let workDir: string;
let fakeHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "helios-hookcfg-work-"));
  fakeHome = await mkdtemp(join(tmpdir(), "helios-hookcfg-home-"));
  // loadHookConfig 内部用 os.homedir() 读用户级配置；覆盖 HOME 避免测试碰真实用户目录。
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(workDir, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
});

describe("loadHookConfig —— 用户级 + 项目级合并", () => {
  it("两层都存在时全部追加，项目级排在用户级之后", async () => {
    await writeHooksFile(fakeHome, { hooks: [{ event: "Stop", command: "user-cmd" }] });
    await writeHooksFile(workDir, { hooks: [{ event: "Stop", command: "project-cmd" }] });
    const { logger } = capturingLogger();

    const entries = await loadHookConfig(workDir, logger);
    expect(entries.map((e) => e.command)).toEqual(["user-cmd", "project-cmd"]);
  });

  it("单层文件缺失时返回另一层结果，不报错", async () => {
    await writeHooksFile(workDir, { hooks: [{ event: "Stop", command: "project-cmd" }] });
    const { logger } = capturingLogger();

    const entries = await loadHookConfig(workDir, logger);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command).toBe("project-cmd");
  });

  it("两层都不存在时返回空数组，不报错", async () => {
    const { logger, warns } = capturingLogger();
    const entries = await loadHookConfig(workDir, logger);
    expect(entries).toEqual([]);
    expect(warns).toHaveLength(0);
  });

  it("JSON 损坏时跳过该文件并 warn，不中止", async () => {
    await mkdir(join(workDir, ".helios"), { recursive: true });
    await writeFile(join(workDir, ".helios", "hooks.json"), "{not valid json", "utf8");
    const { logger, warns } = capturingLogger();

    const entries = await loadHookConfig(workDir, logger);
    expect(entries).toEqual([]);
    expect(warns.some((w) => w.includes("解析失败"))).toBe(true);
  });

  it("非法条目被过滤，合法条目正常保留", async () => {
    await writeHooksFile(workDir, {
      hooks: [
        { event: "Stop", command: "ok-cmd" },
        { event: "NotAnEvent", command: "bad-event" },
        { event: "Stop" }, // 缺 command
        { event: "PreToolUse", command: "ok-cmd-2", matcher: "Bash" },
      ],
    });
    const { logger, warns } = capturingLogger();

    const entries = await loadHookConfig(workDir, logger);
    expect(entries.map((e) => e.command)).toEqual(["ok-cmd", "ok-cmd-2"]);
    expect(warns.length).toBeGreaterThanOrEqual(2);
  });

  it("支持全部 6 种事件枚举值", async () => {
    const allEvents: HookConfigEntry["event"][] = [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ];
    await writeHooksFile(
      workDir,
      { hooks: allEvents.map((event) => ({ event, command: `cmd-${event}` })) },
    );
    const { logger } = capturingLogger();

    const entries = await loadHookConfig(workDir, logger);
    expect(entries.map((e) => e.event)).toEqual(allEvents);
  });
});

describe("toHookBindings —— 转换正确性", () => {
  it("每条 entry 转出对应 event 的 HookBinding，数量与顺序一致", () => {
    const entries: HookConfigEntry[] = [
      { event: "PreToolUse", command: "c1" },
      { event: "SessionEnd", command: "c2" },
    ];
    const { logger } = capturingLogger();
    const bindings = toHookBindings(entries, { workDir, logger });
    expect(bindings.map((b) => b.event)).toEqual(["PreToolUse", "SessionEnd"]);
  });
});
