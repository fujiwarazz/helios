export { WorkspacePaths } from "./paths";
export {
  LocalWorkspaceCatalog,
  UnsupportedSchemaVersionError,
  WorkspaceCatalogError,
  type LocalWorkspaceCatalogOptions,
  type WorkspaceCatalog,
} from "./catalog";
export {
  DEFAULT_GIT_TIMEOUT_MS,
  ExecaGitRunner,
  LocalRepositoryService,
  type GitRunner,
  type GitRunOptions,
  type LocalRepositoryServiceOptions,
  type RepositoryService,
} from "./repositoryService";
export {
  LocalWorkspaceMaterializer,
  type MaterializeOptions,
  type LocalWorkspaceMaterializerOptions,
  type WorkspaceMaterializer,
} from "./materializer";
export {
  LocalSessionCatalog,
  SessionBindingConflictError,
  SessionCatalogError,
  type LocalSessionCatalogOptions,
  type SessionCatalog,
} from "./sessionCatalog";
export {
  AmbiguousLegacySessionError,
  LegacySessionMigrator,
  type LegacySessionMigratorOptions,
} from "./legacySessionMigrator";
export { WorkspaceMemoryStore } from "./memoryStore";
export { LocalDataRootLease } from "./dataRootLease";
export {
  LocalRuntimeRegistry,
  WorkspaceUnavailableError,
  type BoundSession,
  type LocalRuntimeRegistryOptions,
  type RuntimeRegistry,
  type RuntimeSessionOptions,
} from "./runtimeRegistry";
export { LocalEditRecordStore, type LocalEditRecordStoreOptions } from "./editRecordStore";
export { fingerprintWorkspace } from "./workspaceFingerprint";
export {
  LocalMutationCoordinator,
  type ExternalModificationWarning,
  type MutationRunContext,
} from "./mutationCoordinator";
export type {
  CloneWorkspaceRequest,
  EditRecord,
  ImportLocalWorkspaceRequest,
  MaterializationStrategy,
  MaterializedWorkspace,
  MutationJournalRecord,
  SessionLaunchRequest,
  SessionMode,
  SessionRecord,
  SessionState,
  SessionWorkspaceBinding,
  Workspace,
  WorkspaceEnvelope,
  WorkspaceKind,
  WorkspaceRoot,
  WorkspaceRootBinding,
  WorkspaceRootSelection,
  WorkspaceRootSource,
  WorkspaceSummary,
} from "./types";
