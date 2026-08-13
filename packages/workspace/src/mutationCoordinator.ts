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
  onExternalModification?: (warning: ExternalModificationWarning) => Promise<void>;
}

export interface ExternalModificationWarning {
  expectedFingerprint: string;
  actualFingerprint: string;
}

export class LocalMutationCoordinator {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  private readonly afterFingerprints = new Map<string, string>();

  constructor(
    private readonly paths: WorkspacePaths,
    private readonly now: () => number = Date.now,
  ) {}

  async run<T>(context: MutationRunContext, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(context);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async acquire(context: MutationRunContext): Promise<() => Promise<void>> {
    const key = realpathSync(context.rootPath);
    const releaseLock = await this.acquireLock(key);
    let beforeFingerprint: string;
    let externalModification = false;
    try {
      beforeFingerprint = await fingerprintWorkspace(key);
      const file = this.paths.mutationLog(context.workspaceId, context.materializationId);
      const previous = await this.previousJournalState(file);
      if (
        previous.afterFingerprint !== undefined &&
        previous.afterFingerprint !== beforeFingerprint
      ) {
        externalModification = true;
        await context.onExternalModification?.({
          expectedFingerprint: previous.afterFingerprint,
          actualFingerprint: beforeFingerprint,
        });
      }
    } catch (error) {
      releaseLock();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        const afterFingerprint = await fingerprintWorkspace(key);
        await this.appendJournal(
          context,
          beforeFingerprint,
          afterFingerprint,
          externalModification,
        );
      } finally {
        releaseLock();
      }
    };
  }

  private async appendJournal(
    context: MutationRunContext,
    beforeFingerprint: string,
    afterFingerprint: string,
    externalModification: boolean,
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
      ...(externalModification ? { externalModification: true } : {}),
      createdAt: this.now(),
    };
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    this.afterFingerprints.set(file, afterFingerprint);
  }

  private async previousJournalState(
    file: string,
  ): Promise<{ revision: number; afterFingerprint?: string }> {
    const cachedRevision = this.revisions.get(file);
    const cachedFingerprint = this.afterFingerprints.get(file);
    if (cachedRevision !== undefined && cachedFingerprint !== undefined) {
      return { revision: cachedRevision, afterFingerprint: cachedFingerprint };
    }
    const previous = await readLastJournal(file);
    this.revisions.set(file, previous.revision);
    if (previous.afterFingerprint !== undefined) {
      this.afterFingerprints.set(file, previous.afterFingerprint);
    }
    return previous;
  }

  private async acquireLock(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, barrier);
    await previous.catch(() => undefined);
    return () => {
      release();
      if (this.locks.get(key) === barrier) this.locks.delete(key);
    };
  }
}

async function readLastRevision(file: string): Promise<number> {
  return (await readLastJournal(file)).revision;
}

async function readLastJournal(
  file: string,
): Promise<{ revision: number; afterFingerprint?: string }> {
  try {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    if (lines.length === 0) return { revision: 0 };
    const last = JSON.parse(lines.at(-1)!) as {
      revision?: unknown;
      afterFingerprint?: unknown;
    };
    return {
      revision: typeof last.revision === "number" ? last.revision : 0,
      ...(typeof last.afterFingerprint === "string"
        ? { afterFingerprint: last.afterFingerprint }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0 };
    throw error;
  }
}
