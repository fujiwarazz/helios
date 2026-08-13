// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@helios/workspace/types";
import { ModeSwitch } from "./ModeSwitch";
import { WorkspaceComposer } from "./WorkspaceComposer";

afterEach(cleanup);

const localWorkspace: WorkspaceSummary = {
  id: "ws_local",
  name: "Local",
  kind: "local-directory",
  roots: [{ id: "root_local", displayName: "Local", git: false }],
};

const gitWorkspace: WorkspaceSummary = {
  id: "ws_git",
  name: "Git",
  kind: "git-clone",
  roots: [{ id: "root_git", displayName: "Git", git: true }],
};

describe("electron workspace composer", () => {
  it("defaults the mode switch to Chat and can select Code", () => {
    const onChange = vi.fn();
    render(<ModeSwitch mode="chat" onChange={onChange} />);
    expect(screen.getByTestId("mode-chat").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("mode-code"));
    expect(onChange).toHaveBeenCalledWith("code");
  });

  it("imports a native directory as a summary and selects direct", async () => {
    const onChange = vi.fn();
    render(
      <WorkspaceComposer
        workspaces={[]}
        selection={{ strategy: "direct" }}
        onChange={onChange}
        onClone={async () => undefined}
        onSelectDirectory={async () => localWorkspace}
      />,
    );

    fireEvent.click(screen.getByTestId("select-directory"));
    await screen.findByRole("option", { name: "Local" });
    expect(onChange).toHaveBeenCalledWith({
      workspaceId: "ws_local",
      rootId: "root_local",
      strategy: "direct",
    });
  });

  it("only enables worktree for Git and locks controls after first send", () => {
    const { rerender } = render(
      <WorkspaceComposer
        workspaces={[localWorkspace, gitWorkspace]}
        selection={{ workspaceId: "ws_local", rootId: "root_local", strategy: "direct" }}
        onChange={() => {}}
        onClone={async () => undefined}
        onSelectDirectory={async () => undefined}
      />,
    );
    expect((screen.getByTestId("strategy-worktree") as HTMLInputElement).disabled).toBe(true);

    rerender(
      <WorkspaceComposer
        workspaces={[localWorkspace, gitWorkspace]}
        selection={{ workspaceId: "ws_git", rootId: "root_git", strategy: "direct" }}
        locked
        onChange={() => {}}
        onClone={async () => undefined}
        onSelectDirectory={async () => undefined}
      />,
    );
    expect((screen.getByTestId("workspace-select") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText("仓库已绑定；如需切换，请新建会话")).toBeTruthy();
  });
});
