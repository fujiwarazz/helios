import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@helios/workspace";
import { selectAndImportDirectory } from "./directoryDialog";

const workspace: Workspace = {
  id: "ws_1",
  name: "Repo",
  kind: "local-directory",
  roots: [
    {
      id: "root_1",
      displayName: "Repo",
      source: { type: "local", path: "/secret/repo" },
      git: { defaultBranch: "main" },
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};

describe("native directory selection", () => {
  it("returns undefined when the dialog is canceled", async () => {
    const dialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    };
    const importLocalDirectory = vi.fn();

    await expect(
      selectAndImportDirectory(dialog, {}, { importLocalDirectory }),
    ).resolves.toBeUndefined();
    expect(importLocalDirectory).not.toHaveBeenCalled();
  });

  it("uses a fixed directory-only dialog and returns a path-free summary", async () => {
    const dialog = {
      showOpenDialog: vi.fn(async () => ({
        canceled: false,
        filePaths: ["/secret/repo"],
      })),
    };
    const importLocalDirectory = vi.fn(async () => workspace);

    const result = await selectAndImportDirectory(dialog, {}, { importLocalDirectory });

    expect(dialog.showOpenDialog).toHaveBeenCalledWith({}, {
      properties: ["openDirectory"],
    });
    expect(importLocalDirectory).toHaveBeenCalledWith("/secret/repo");
    expect(result).toEqual({
      id: "ws_1",
      name: "Repo",
      kind: "local-directory",
      roots: [{ id: "root_1", displayName: "Repo", git: true }],
    });
    expect(JSON.stringify(result)).not.toContain("/secret/repo");
  });
});
