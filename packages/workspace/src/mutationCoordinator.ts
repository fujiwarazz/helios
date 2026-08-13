import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspacePaths } from "./paths";
import type { MutationJournalRecord } from "./types";
import { fingerprintWorkspace } from "./workspaceFingerprint";

export interface MutationRunContext {
  workspaceId: string;
  materializationId: string;
  rootPath: string;
  sessionId: string;
  runId: string;
}

export class LocalMutationCoordinator {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(context: MutationRunContext, operation: () => Promise<T>): Promise<T> {
    const key = realpathSync(context.rootPath);
    return this.withLock(key, async () => {
      const beforeFingerprint = await fingerprintWorkspace(key);
      let result: T;
      let failure: unknown;
      try {
        result = await operation();
      } catch (error) {
        failure = error;
        result = undefined as T;
      }
      const afterFingerprint = await fingerprintWorkspace(key);
      await this.appendJournal(context, beforeFingerprint, afterFingerprint);
      if (failure !== undefined) throw failure;
      return result;
    });
  }

  private async appendJournal(
    context: MutationRunContext,
    beforeFingerprint: string,
    afterFingerprint: string,
  ): Promise<void> {
    const file = this.paths.mutationLog(context.workspaceId, context.materializationId);
    const previous = this.revisions.get(file) ?? (await readLastRevision(file));
    const revision = previous + 1;
    this.revisions.set(file, revision);
    const record: MutationJournalRecord = {
      schemaVersion: 1,
      revision,
      sessionId: context.sessionId,
      runId: context.runId,
      beforeFingerprint,
      afterFingerprint,
      createdAt: this.now(),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, barrier);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === barrier) this.locks.delete(key);
    }
  }
}

async function readLastRevision(file: string): Promise<number> {
  try {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    if (lines.length === 0) return 0;
    const last = JSON.parse(lines.at(-1)!) as { revision?: unknown };
    return typeof last.revision === "number" ? last.revision : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}
