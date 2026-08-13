import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalWorkspaceCatalog } from "./catalog";
import {
  AmbiguousLegacySessionError,
  LegacySessionMigrator,
} from "./legacySessionMigrator";
import { WorkspacePaths } from "./paths";
import { LocalRepositoryService } from "./repositoryService";
import { LocalSessionCatalog } from "./sessionCatalog";

describe("LegacySessionMigrator", () => {
  let dataRoot: string;
  let legacyRoot: string;
  let secondLegacyRoot: string;
  let paths: WorkspacePaths;
  let catalog: LocalWorkspaceCatalog;
  let sessions: LocalSessionCatalog;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-legacy-state-"));
    legacyRoot = await mkdtemp(join(tmpdir(), "helios-legacy-workdir-"));
    secondLegacyRoot = await mkdtemp(join(tmpdir(), "helios-legacy-workdir-"));
    paths = new WorkspacePaths(dataRoot);
    let id = 0;
    catalog = new LocalWorkspaceCatalog(paths, {
      idFactory: (prefix) => `${prefix}_${id++}`,
      now: () => 50,
    });
    sessions = new LocalSessionCatalog(paths);
  });

  afterEach(async () => {
    await Promise.all(
      [dataRoot, legacyRoot, secondLegacyRoot].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  it("migrates one explicit legacy root into a versioned global session and binding", async () => {
    await writeLegacySession(legacyRoot, "sess_legacy");
    const migrator = createMigrator([legacyRoot]);

    const migrated = await migrator.migrate("sess_legacy");

    expect(migrated).toMatchObject({
      schemaVersion: 1,
      meta: { id: "sess_legacy", title: "Legacy title", createdAt: 10 },
      binding: {
        sessionId: "sess_legacy",
        mode: "code",
        roots: [{ strategy: "direct" }],
      },
      state: "idle",
    });
    const workspace = await catalog.get(migrated!.binding.workspaceId);
    expect(workspace?.roots[0]?.source).toEqual({
      type: "local",
      path: await realpath(legacyRoot),
    });

    const meta = JSON.parse(await readFile(paths.kernelMeta("sess_legacy"), "utf8"));
    expect(meta).toMatchObject({ schemaVersion: 1, id: "sess_legacy", lastRunIndex: 0 });
    const turn = JSON.parse(
      (await readFile(paths.turnLog("sess_legacy"), "utf8")).trim(),
    );
    expect(turn).toMatchObject({ schemaVersion: 1, runIndex: 0, turnIndex: 0 });
    await expect(
      readFile(join(legacyRoot, ".helios", "sessions", "sess_legacy", "meta.json"), "utf8"),
    ).resolves.toContain("Legacy title");
  });

  it("is idempotent after a successful migration", async () => {
    await writeLegacySession(legacyRoot, "sess_legacy");
    const migrator = createMigrator([legacyRoot]);

    const first = await migrator.migrate("sess_legacy");
    const second = await migrator.migrate("sess_legacy");

    expect(second).toEqual(first);
    expect(await catalog.list()).toHaveLength(1);
  });

  it("returns undefined when explicit roots contain no matching legacy session", async () => {
    await expect(createMigrator([legacyRoot]).migrate("sess_missing")).resolves.toBeUndefined();
  });

  it("rejects an ambiguous session found under multiple explicit roots", async () => {
    await writeLegacySession(legacyRoot, "sess_duplicate");
    await writeLegacySession(secondLegacyRoot, "sess_duplicate");

    await expect(
      createMigrator([legacyRoot, secondLegacyRoot]).migrate("sess_duplicate"),
    ).rejects.toBeInstanceOf(AmbiguousLegacySessionError);
    expect(await catalog.list()).toEqual([]);
  });

  function createMigrator(legacyRoots: string[]): LegacySessionMigrator {
    return new LegacySessionMigrator({
      paths,
      repositories: new LocalRepositoryService({
        catalog,
        paths,
        allowedRoots: legacyRoots,
        idFactory: (prefix) => `${prefix}_migrated`,
        now: () => 50,
      }),
      sessions,
      legacyRoots,
    });
  }
});

async function writeLegacySession(root: string, sessionId: string): Promise<void> {
  const directory = join(root, ".helios", "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "meta.json"),
    JSON.stringify({
      id: sessionId,
      title: "Legacy title",
      createdAt: 10,
      updatedAt: 20,
      lastRunIndex: 0,
      lastTurnIndex: 0,
    }),
    "utf8",
  );
  await writeFile(
    join(directory, "turns.jsonl"),
    `${JSON.stringify({
      turnId: `${sessionId}-0-0`,
      runIndex: 0,
      turnIndex: 0,
      checkpointRef: { kind: "fs", value: "legacy" },
      anchorNodeId: null,
      messages: [
        { id: "msg_user", role: "user", content: "hello", parentId: null },
        {
          id: "msg_assistant",
          role: "assistant",
          content: [{ type: "text", text: "world" }],
          parentId: "msg_user",
        },
      ],
    })}\n`,
    "utf8",
  );
}
