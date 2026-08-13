import type { Workspace, WorkspaceSummary } from "@helios/workspace";

export interface DirectoryDialogPort {
  showOpenDialog(
    window: unknown,
    options: { properties: ["openDirectory"] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface LocalDirectoryImporter {
  importLocalDirectory(path: string): Promise<Workspace>;
}

export async function selectAndImportDirectory(
  dialog: DirectoryDialogPort,
  window: unknown,
  repositories: LocalDirectoryImporter,
): Promise<WorkspaceSummary | undefined> {
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  const path = result.filePaths[0];
  if (result.canceled || !path) return undefined;
  return toWorkspaceSummary(await repositories.importLocalDirectory(path));
}

function toWorkspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    kind: workspace.kind,
    roots: workspace.roots.map((root) => ({
      id: root.id,
      displayName: root.displayName,
      git: root.git !== undefined,
    })),
  };
}
