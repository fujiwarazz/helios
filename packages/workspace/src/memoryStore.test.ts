import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceMemoryStore } from "./memoryStore";
import { WorkspacePaths } from "./paths";

describe("WorkspaceMemoryStore", () => {
  let dataRoot: string;
  let memory: WorkspaceMemoryStore;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-workspace-memory-"));
    memory = new WorkspaceMemoryStore(new WorkspacePaths(dataRoot));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("isolates index and topic memory by workspace id", async () => {
    await memory.writeIndex("ws_a", "A memory");
    await memory.writeIndex("ws_b", "B memory");
    await memory.writeTopic("ws_a", "architecture", "A topic");

    expect(await memory.readIndex("ws_a")).toBe("A memory");
    expect(await memory.readIndex("ws_b")).toBe("B memory");
    expect(await memory.readTopic("ws_a", "architecture")).toBe("A topic");
    expect(await memory.readTopic("ws_b", "architecture")).toBe("");
  });

  it("rejects unsafe workspace and topic identities", async () => {
    await expect(memory.writeIndex("../outside", "bad")).rejects.toThrow(/invalid id/i);
    await expect(memory.writeTopic("ws_a", "../outside", "bad")).rejects.toThrow(/invalid topic/i);
  });
});
