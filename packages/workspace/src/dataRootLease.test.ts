import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDataRootLease } from "./dataRootLease";

describe("LocalDataRootLease", () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-data-root-lease-"));
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("exclusively owns a dataRoot until disposed", async () => {
    const first = await LocalDataRootLease.acquire(dataRoot);

    await expect(LocalDataRootLease.acquire(dataRoot)).rejects.toThrow(
      /already in use|different HELIOS_DATA_ROOT/i,
    );

    await first.dispose();
    const next = await LocalDataRootLease.acquire(dataRoot);
    await next.dispose();
  });

  it("allows independent data roots and dispose is idempotent", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "helios-data-root-lease-other-"));
    try {
      const first = await LocalDataRootLease.acquire(dataRoot);
      const second = await LocalDataRootLease.acquire(otherRoot);

      await first.dispose();
      await first.dispose();
      await second.dispose();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});
