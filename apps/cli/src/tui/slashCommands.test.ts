import { describe, expect, it, vi } from "vitest";
import {
  parseSlashCommand,
  runSlashCommand,
  type BranchChoice,
  type SlashCommandHost,
} from "./slashCommands";

function createHost(overrides: Partial<SlashCommandHost> = {}): SlashCommandHost & {
  notices: string[];
  statuses: string[];
} {
  const notices: string[] = [];
  const statuses: string[] = [];
  return {
    notices,
    statuses,
    isBusy: () => false,
    notice: (text) => notices.push(text),
    status: (text) => statuses.push(text),
    clearTranscript: vi.fn(),
    describeModel: () => ({ provider: "@helios/llm-openai", model: "gpt-5.4-mini" }),
    listBranches: () => [],
    switchBranch: vi.fn(),
    chooseBranch: () => Promise.resolve(undefined),
    resumeSession: (sessionId) => Promise.resolve(sessionId),
    ...overrides,
  };
}

describe("parseSlashCommand", () => {
  it("leaves ordinary prompts untouched", () => {
    expect(parseSlashCommand("explain /tree in the docs")).toBeUndefined();
    expect(parseSlashCommand("")).toBeUndefined();
  });

  it("splits name and arguments case-insensitively", () => {
    expect(parseSlashCommand("/Help")).toEqual({ name: "help", args: "" });
    expect(parseSlashCommand("  /resume  session_42  ")).toEqual({
      name: "resume",
      args: "session_42",
    });
  });
});

describe("runSlashCommand", () => {
  it("reports unknown commands without touching the session", async () => {
    const host = createHost();
    await runSlashCommand({ name: "reboot", args: "" }, host);
    expect(host.notices[0]).toContain("未知命令 /reboot");
    expect(host.statuses[0]).toBe("Unknown command: /reboot");
  });

  it("/model prints configuration and states that routing is not mutated", async () => {
    const host = createHost();
    await runSlashCommand({ name: "model", args: "" }, host);
    expect(host.notices[0]).toContain("gpt-5.4-mini");
    expect(host.notices[0]).toContain("helios.config.json");
  });

  it("/tree switches to the chosen leaf and skips the call when cancelled", async () => {
    const choices: BranchChoice[] = [{ leafId: "leaf-1", depth: 2, active: false }];
    const switchBranch = vi.fn();
    const cancelled = createHost({ listBranches: () => choices, switchBranch });
    await runSlashCommand({ name: "tree", args: "" }, cancelled);
    expect(switchBranch).not.toHaveBeenCalled();

    const selecting = createHost({
      listBranches: () => choices,
      switchBranch,
      chooseBranch: () => Promise.resolve("leaf-1"),
    });
    await runSlashCommand({ name: "tree", args: "" }, selecting);
    expect(switchBranch).toHaveBeenCalledWith("leaf-1");
  });

  it("/resume validates the argument and refuses while busy", async () => {
    const resumeSession = vi.fn(() => Promise.resolve("session-2"));
    const empty = createHost({ resumeSession });
    await runSlashCommand({ name: "resume", args: "" }, empty);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(empty.statuses[0]).toBe("用法：/resume <session-id>");

    const busy = createHost({ isBusy: () => true, resumeSession });
    await runSlashCommand({ name: "resume", args: "session-2" }, busy);
    expect(resumeSession).not.toHaveBeenCalled();

    const idle = createHost({ resumeSession });
    await runSlashCommand({ name: "resume", args: "session-2" }, idle);
    expect(resumeSession).toHaveBeenCalledWith("session-2");
    expect(idle.statuses.at(-1)).toBe("已切换到会话 session-2");
  });

  it("surfaces replacement failures as a status without throwing", async () => {
    const host = createHost({ resumeSession: () => Promise.reject(new Error("materialize failed")) });
    await runSlashCommand({ name: "resume", args: "session-9" }, host);
    expect(host.statuses.at(-1)).toBe("resume 失败：materialize failed");
  });
});
