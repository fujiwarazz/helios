import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalEditRecordStore } from "./editRecordStore";
import { WorkspacePaths } from "./paths";
import type { EditRecord } from "./types";

describe("LocalEditRecordStore", () => {
  let dataRoot: string;
  let paths: WorkspacePaths;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-edit-record-"));
    paths = new WorkspacePaths(dataRoot);
  });

  afterEach(async () => rm(dataRoot, { recursive: true, force: true }));

  it("appends and lists versioned records while skipping corrupt rows with a warning", async () => {
    const warn = vi.fn();
    const store = new LocalEditRecordStore(paths, { warn });
    await store.append(record());
    await appendFile(paths.editLog("sess_1"), "not json\n", "utf8");

    expect(await store.list("sess_1")).toEqual([record()]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects unsafe relative paths and oversized complete records", async () => {
    const store = new LocalEditRecordStore(paths, { maxRecordBytes: 100 });
    await expect(store.append({ ...record(), relativePath: "../escape" })).rejects.toThrow(
      /relative path/i,
    );
    await expect(store.append({ ...record(), after: "x".repeat(500) })).rejects.toThrow(
      /too large/i,
    );
  });
});

function record(): EditRecord {
  return {
    schemaVersion: 1,
    id: "edit_1",
    sessionId: "sess_1",
    workspaceId: "ws_1",
    rootId: "root_1",
    toolUseId: "tool_1",
    relativePath: "src/a.ts",
    operation: "update",
    before: "old",
    after: "new",
    createdAt: 1,
  };
}
