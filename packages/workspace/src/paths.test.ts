import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacePaths } from "./paths";

describe("WorkspacePaths", () => {
  it.each(["", "../outside", "/absolute", "nested/id", "nested\\id", ".hidden"])(
    "rejects an unsafe id: %j",
    (id) => {
      const paths = new WorkspacePaths("/data/helios");
      expect(() => paths.sessionDir(id)).toThrow(/invalid id/i);
    },
  );

  it("keeps managed roots below dataRoot", () => {
    const paths = new WorkspacePaths("/data/helios");
    expect(paths.managedRoot("ws_1")).toBe(resolve("/data/helios/managed-workspaces/ws_1/root"));
    expect(paths.editLog("sess_1")).toBe(resolve("/data/helios/sessions/sess_1/edits.jsonl"));
    expect(paths.repositorySource("repo_1")).toBe(resolve("/data/helios/repositories/repo_1/source"));
  });

  it("uses materialization identity in worktree and mutation paths", () => {
    const paths = new WorkspacePaths("/data/helios");
    expect(paths.worktreeRoot("ws_1", "mat_1", "root_1")).toBe(
      resolve("/data/helios/worktrees/ws_1/mat_1/root_1"),
    );
    expect(paths.mutationLog("ws_1", "mat_1")).toBe(
      resolve("/data/helios/workspace-state/ws_1/mat_1/mutations.jsonl"),
    );
  });

  it("constructs catalog, session, memory, and host-lock paths", () => {
    const paths = new WorkspacePaths("./relative-state");
    const root = resolve("./relative-state");
    expect(paths.dataRoot).toBe(root);
    expect(paths.workspaceFile("ws_1")).toBe(resolve(root, "workspaces/ws_1.json"));
    expect(paths.sessionRecord("sess_1")).toBe(resolve(root, "sessions/sess_1/session.json"));
    expect(paths.memoryDir("ws_1")).toBe(resolve(root, "workspace-memory/ws_1"));
    expect(paths.hostLockTarget()).toBe(resolve(root, ".host-lock-target"));
  });
});
