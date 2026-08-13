import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceCatalog, UnsupportedSchemaVersionError } from "./catalog";
import { WorkspacePaths } from "./paths";
import type { Workspace } from "./types";

describe("LocalWorkspaceCatalog", () => {
  let dataRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalWorkspaceCatalog;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-workspace-catalog-"));
    paths = new WorkspacePaths(dataRoot);
    catalog = new LocalWorkspaceCatalog(paths, {
      idFactory: (prefix) => `${prefix}_test`,
      now: () => 100,
    });
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("creates a managed chat root and round-trips it", async () => {
    const workspace = await catalog.createManagedChat("Chat files");

    expect(workspace).toMatchObject({
      id: "ws_test",
      name: "Chat files",
      kind: "managed-chat",
      createdAt: 100,
      updatedAt: 100,
    });
    expect(workspace.roots).toEqual([
      {
        id: "root_test",
        displayName: "Chat files",
        source: { type: "managed" },
      },
    ]);
    await expect(stat(paths.managedRoot(workspace.id))).resolves.toBeDefined();
    await expect(catalog.get(workspace.id)).resolves.toEqual(workspace);
    await expect(catalog.list()).resolves.toEqual([workspace]);
  });

  it("sorts workspaces by updatedAt and ignores non-json files", async () => {
    const older = workspace("ws_old", 10);
    const newer = workspace("ws_new", 20);
    await catalog.put(older);
    await catalog.put(newer);
    await writeFile(join(dirname(paths.workspaceFile("ws_old")), "README.txt"), "ignored");

    await expect(catalog.list()).resolves.toEqual([newer, older]);
  });

  it("reads a validated legacy v0 workspace", async () => {
    const legacy = workspace("ws_legacy", 5);
    const file = paths.workspaceFile(legacy.id);
    await catalog.put(legacy);
    await writeFile(file, JSON.stringify(legacy), "utf8");

    await expect(catalog.get(legacy.id)).resolves.toEqual(legacy);
  });

  it("reports unsupported and corrupted catalog files with their path", async () => {
    const file = paths.workspaceFile("ws_bad");
    await catalog.put(workspace("ws_bad", 1));
    await writeFile(file, JSON.stringify({ schemaVersion: 2, workspace: {} }), "utf8");

    await expect(catalog.get("ws_bad")).rejects.toEqual(
      expect.objectContaining<Partial<UnsupportedSchemaVersionError>>({ file }),
    );

    await writeFile(file, "{broken", "utf8");
    await expect(catalog.get("ws_bad")).rejects.toThrow(file);
  });

  it("concurrent writes always leave a complete envelope and no temp files", async () => {
    const first = workspace("ws_race", 1);
    const second = workspace("ws_race", 2);
    await Promise.all([catalog.put(first), catalog.put(second)]);

    const raw = JSON.parse(await readFile(paths.workspaceFile("ws_race"), "utf8")) as {
      schemaVersion: number;
      workspace: Workspace;
    };
    expect(raw.schemaVersion).toBe(1);
    expect([first, second]).toContainEqual(raw.workspace);
    expect((await readdir(dirname(paths.workspaceFile("ws_race")))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

function workspace(id: string, updatedAt: number): Workspace {
  return {
    id,
    name: id,
    kind: "managed-chat",
    roots: [{ id: `root_${id}`, displayName: id, source: { type: "managed" } }],
    createdAt: updatedAt,
    updatedAt,
  };
}
