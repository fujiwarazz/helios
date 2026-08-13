export type SessionMode = "chat" | "code";
export type WorkspaceKind = "managed-chat" | "local-directory" | "git-clone";
export type MaterializationStrategy = "direct" | "worktree";

export type WorkspaceRootSource =
  | { type: "managed" }
  | { type: "local"; path: string }
  | { type: "git"; remoteIdentity: string; repositoryId: string };

export interface WorkspaceRoot {
  id: string;
  displayName: string;
  source: WorkspaceRootSource;
  git?: { defaultBranch?: string };
}

export interface Workspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  roots: WorkspaceRoot[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceEnvelope {
  schemaVersion: 1;
  workspace: Workspace;
}

export interface WorkspaceRootSelection {
  rootId: string;
  strategy: MaterializationStrategy;
  branch?: string;
}

export interface WorkspaceRootBinding extends WorkspaceRootSelection {
  materializationId: string;
  revision?: string;
}

export interface SessionWorkspaceBinding {
  sessionId: string;
  mode: SessionMode;
  workspaceId: string;
  roots: WorkspaceRootBinding[];
  /** Ephemeral runtime hint; resume correctness never depends on this value. */
  runtimeId?: string;
  createdAt: number;
}

export interface MaterializedWorkspace {
  workspaceId: string;
  primaryDir: string;
  additionalDirs: string[];
  roots: Array<{
    rootId: string;
    absolutePath: string;
    readOnly: boolean;
  }>;
}

export interface SessionLaunchRequest {
  mode: SessionMode;
  workspaceId?: string;
  roots?: WorkspaceRootSelection[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: WorkspaceKind;
  roots: Array<{ id: string; displayName: string; git: boolean }>;
}

export interface CloneWorkspaceRequest {
  remoteUrl: string;
  name?: string;
}

export interface ImportLocalWorkspaceRequest {
  path: string;
  name?: string;
}

export type SessionState = "starting" | "running" | "idle" | "interrupted";

export interface SessionRecord {
  schemaVersion: 1;
  meta: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  };
  binding: SessionWorkspaceBinding;
  state: SessionState;
  auditStatus: "complete" | "incomplete";
  auditGaps: Array<{ toolUseId?: string; reason: string; createdAt: number }>;
}

export interface EditRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  workspaceId: string;
  rootId: string;
  toolUseId: string;
  relativePath: string;
  operation: "create" | "update" | "delete";
  before?: string;
  after?: string;
  createdAt: number;
}

export interface MutationJournalRecord {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  runId: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  externalModification?: boolean;
  createdAt: number;
}
