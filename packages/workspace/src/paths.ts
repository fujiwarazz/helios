import { join, resolve } from "node:path";
import { SESSION_LOG_FILE } from "@helios/kernel";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function assertId(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`invalid id: ${JSON.stringify(id)}`);
  }
  return id;
}

export class WorkspacePaths {
  readonly dataRoot: string;

  constructor(dataRoot: string) {
    this.dataRoot = resolve(dataRoot);
  }

  workspaceFile(workspaceId: string): string {
    return join(this.workspaceDir(), `${assertId(workspaceId)}.json`);
  }

  workspaceDir(): string {
    return join(this.dataRoot, "workspaces");
  }

  managedRoot(workspaceId: string): string {
    return join(this.dataRoot, "managed-workspaces", assertId(workspaceId), "root");
  }

  repositorySource(repositoryId: string): string {
    return join(this.dataRoot, "repositories", assertId(repositoryId), "source");
  }

  worktreeRoot(workspaceId: string, materializationId: string, rootId: string): string {
    return join(
      this.dataRoot,
      "worktrees",
      assertId(workspaceId),
      assertId(materializationId),
      assertId(rootId),
    );
  }

  memoryDir(workspaceId: string): string {
    return join(this.dataRoot, "workspace-memory", assertId(workspaceId));
  }

  sessionDir(sessionId: string): string {
    return join(this.dataRoot, "sessions", assertId(sessionId));
  }

  sessionRecord(sessionId: string): string {
    return join(this.sessionDir(sessionId), "session.json");
  }

  kernelMeta(sessionId: string): string {
    return join(this.sessionDir(sessionId), "kernel-meta.json");
  }

  /** kernel 的会话 append-only 日志（文件名真源在 @helios/kernel 的 SESSION_LOG_FILE）。 */
  sessionLog(sessionId: string): string {
    return join(this.sessionDir(sessionId), SESSION_LOG_FILE);
  }

  editLog(sessionId: string): string {
    return join(this.sessionDir(sessionId), "edits.jsonl");
  }

  mutationLog(workspaceId: string, materializationId: string): string {
    return join(
      this.dataRoot,
      "workspace-state",
      assertId(workspaceId),
      assertId(materializationId),
      "mutations.jsonl",
    );
  }

  hostLockTarget(): string {
    return join(this.dataRoot, ".host-lock-target");
  }
}
