import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalMutationCoordinator } from "./mutationCoordinator";
import { WorkspacePaths } from "./paths";

describe("LocalMutationCoordinator", () => {
  let dataRoot: string;
  let root: string;
  let coordinator: LocalMutationCoordinator;

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "helios-mutation-state-"));
    root = await mkdtemp(join(tmpdir(), "helios-mutation-root-"));
    coordinator = new LocalMutationCoordinator(new WorkspacePaths(dataRoot));
  });
  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it("serializes whole runs and persists monotonic fingerprinted revisions", async () => {
    const order: string[] = [];
    const first = coordinator.run(context("sess_1", "run_1"), async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(root, "a.txt"), "one");
      order.push("first-end");
    });
    const second = coordinator.run(context("sess_2", "run_2"), async () => {
      order.push("second-start");
      await writeFile(join(root, "a.txt"), "two");
      order.push("second-end");
    });
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    const rows = (await readFile(
      new WorkspacePaths(dataRoot).mutationLog("ws_1", "direct-root_1"),
      "utf8",
    ))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(rows.map((row) => row.sessionId)).toEqual(["sess_1", "sess_2"]);
    expect(rows[0].beforeFingerprint).not.toBe(rows[0].afterFingerprint);
  });

  function context(sessionId: string, runId: string) {
    return {
      workspaceId: "ws_1",
      materializationId: "direct-root_1",
      rootPath: root,
      sessionId,
      runId,
    };
  }
});
