import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspacePaths } from "./paths";
import {
  LocalSessionCatalog,
  SessionBindingConflictError,
} from "./sessionCatalog";
import type { SessionRecord } from "./types";

describe("LocalSessionCatalog", () => {
  let dataRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalSessionCatalog;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-session-catalog-"));
    paths = new WorkspacePaths(dataRoot);
    catalog = new LocalSessionCatalog(paths, { now: () => 99 });
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates a versioned record once and lists newest sessions first", async () => {
    const older = record("sess_old", "ws_1", 1);
    const newer = record("sess_new", "ws_2", 2);

    await catalog.create(older);
    await catalog.create(newer);

    expect(await catalog.get(older.meta.id)).toEqual({ ...older, state: "starting" });
    expect((await catalog.list()).map((item) => item.meta.id)).toEqual(["sess_new", "sess_old"]);
    expect(JSON.parse(await readFile(paths.sessionRecord("sess_old"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      binding: { workspaceId: "ws_1" },
    });
  });

  it("treats an identical binding as idempotent and rejects a conflicting binding", async () => {
    const original = record("sess_1", "ws_1", 1);
    await catalog.create(original);

    await expect(catalog.create({ ...original, state: "idle" })).resolves.toBeUndefined();
    await expect(catalog.create(record("sess_1", "ws_other", 2))).rejects.toBeInstanceOf(
      SessionBindingConflictError,
    );
    expect((await catalog.get("sess_1"))?.binding.workspaceId).toBe("ws_1");
  });

  it("updates state and persists audit gaps", async () => {
    await catalog.create(record("sess_1", "ws_1", 1));

    await catalog.updateState("sess_1", "running");
    await catalog.appendAuditGap("sess_1", {
      toolUseId: "tool_1",
      reason: "edit record failed",
      createdAt: 3,
    });

    expect(await catalog.get("sess_1")).toMatchObject({
      state: "running",
      auditStatus: "incomplete",
      auditGaps: [{ toolUseId: "tool_1", reason: "edit record failed", createdAt: 3 }],
    });
  });

  it("reconciles starting and running records as interrupted after an ungraceful shutdown", async () => {
    await catalog.create(record("sess_start", "ws_1", 1));
    await catalog.create(record("sess_run", "ws_1", 2));
    await catalog.updateState("sess_run", "running");
    await catalog.create(record("sess_idle", "ws_1", 3));
    await catalog.updateState("sess_idle", "idle");

    await expect(catalog.reconcileInterrupted()).resolves.toBe(2);
    expect(await catalog.get("sess_start")).toMatchObject({
      state: "interrupted",
      auditStatus: "incomplete",
      auditGaps: [{ reason: "ungraceful-shutdown", createdAt: 99 }],
    });
    expect((await catalog.get("sess_run"))?.state).toBe("interrupted");
    expect((await catalog.get("sess_idle"))?.state).toBe("idle");
  });

  it("rejects corrupt and unsupported records with the file name", async () => {
    const file = paths.sessionRecord("sess_bad");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "not json", "utf8");
    await expect(catalog.get("sess_bad")).rejects.toMatchObject({ file });

    await writeFile(file, JSON.stringify({ ...record("sess_bad", "ws_1", 1), schemaVersion: 2 }));
    await expect(catalog.get("sess_bad")).rejects.toThrow(/unsupported session schema version 2/i);
  });

  it("uses exclusive create semantics under conflicting concurrent writers", async () => {
    const results = await Promise.allSettled([
      catalog.create(record("sess_race", "ws_a", 1)),
      catalog.create(record("sess_race", "ws_b", 1)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["ws_a", "ws_b"]).toContain((await catalog.get("sess_race"))?.binding.workspaceId);
  });
});

function record(sessionId: string, workspaceId: string, updatedAt: number): SessionRecord {
  return {
    schemaVersion: 1,
    meta: { id: sessionId, title: sessionId, createdAt: updatedAt, updatedAt },
    binding: {
      sessionId,
      mode: "code",
      workspaceId,
      roots: [
        {
          rootId: "root_1",
          strategy: "direct",
          materializationId: "direct-root_1",
        },
      ],
      createdAt: updatedAt,
    },
    state: "idle",
    auditStatus: "complete",
    auditGaps: [],
  };
}
