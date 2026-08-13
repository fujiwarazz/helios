import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelContext } from "@helios/ports";
import { createGuardedFileSystem } from "@helios/fs-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create } from "./index";

describe("memory-fs storageDir", () => {
  let workDir: string;
  let storageDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "helios-memory-workspace-"));
    storageDir = await mkdtemp(join(tmpdir(), "helios-memory-state-"));
  });

  afterEach(async () => {
    await Promise.all(
      [workDir, storageDir].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("uses an isolated guarded filesystem when trusted manifest options provide storageDir", async () => {
    const memory = create({
      workDir,
      options: { storageDir },
      ports: { fileSystem: createGuardedFileSystem(workDir) },
    } as unknown as KernelContext);

    await memory.remember({ key: "shared", text: "workspace memory", ts: 1 });

    expect(await memory.recall("anything")).toContain("shared.md");
    await expect(readFile(join(storageDir, "MEMORY.md"), "utf8")).resolves.toContain("shared.md");
    await expect(readFile(join(workDir, ".helios", "memory", "MEMORY.md"), "utf8")).rejects.toBeDefined();
  });

  it("keeps the legacy workDir/.helios/memory layout without storageDir", async () => {
    const memory = create({
      workDir,
      ports: { fileSystem: createGuardedFileSystem(workDir) },
    } as unknown as KernelContext);

    await memory.remember({ key: "legacy", text: "legacy memory", ts: 1 });

    await expect(readFile(join(workDir, ".helios", "memory", "MEMORY.md"), "utf8")).resolves.toContain(
      "legacy.md",
    );
  });
});
