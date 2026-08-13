import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintWorkspace } from "./workspaceFingerprint";

describe("fingerprintWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "helios-fingerprint-"));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("detects content changes and excludes generated directories", async () => {
    await writeFile(join(root, "a.txt"), "one");
    const first = await fingerprintWorkspace(root);
    await writeFile(join(root, "a.txt"), "two");
    const second = await fingerprintWorkspace(root);
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "ignored.js"), "ignored");

    expect(second).not.toBe(first);
    expect(await fingerprintWorkspace(root)).toBe(second);
  });
});
