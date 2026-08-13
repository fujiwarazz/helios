import { useMemo, useState } from "react";
import type { MaterializationStrategy, WorkspaceSummary } from "@helios/workspace/types";

export interface WorkspaceSelection {
  workspaceId?: string;
  rootId?: string;
  strategy: MaterializationStrategy;
}

export interface WorkspaceComposerProps {
  workspaces: WorkspaceSummary[];
  selection: WorkspaceSelection;
  locked?: boolean;
  onChange(selection: WorkspaceSelection): void;
  onClone(remoteUrl: string): Promise<WorkspaceSummary | undefined>;
  onSelectDirectory(): Promise<WorkspaceSummary | undefined>;
}

export function WorkspaceComposer({
  workspaces,
  selection,
  locked = false,
  onChange,
  onClone,
  onSelectDirectory,
}: WorkspaceComposerProps): JSX.Element {
  const [created, setCreated] = useState<WorkspaceSummary[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const allWorkspaces = useMemo(
    () => [...created, ...workspaces].filter(
      (workspace, index, values) =>
        values.findIndex((candidate) => candidate.id === workspace.id) === index,
    ),
    [created, workspaces],
  );
  const selected = allWorkspaces.find((workspace) => workspace.id === selection.workspaceId);
  const git = selected?.roots.find((root) => root.id === selection.rootId)?.git ?? false;

  const selectWorkspace = (workspaceId: string): void => {
    const workspace = allWorkspaces.find((candidate) => candidate.id === workspaceId);
    const root = workspace?.roots[0];
    onChange({
      workspaceId: workspace?.id,
      rootId: root?.id,
      strategy: "direct",
    });
  };

  const runAndSelect = async (
    action: () => Promise<WorkspaceSummary | undefined>,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await action();
      if (workspace) {
        setCreated((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
        onChange({
          workspaceId: workspace.id,
          rootId: workspace.roots[0]?.id,
          strategy: "direct",
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="helios-workspace-composer">
      <label>
        <span>代码仓库</span>
        <select
          data-testid="workspace-select"
          value={selection.workspaceId ?? ""}
          disabled={locked || busy}
          onChange={(event) => selectWorkspace(event.target.value)}
        >
          <option value="">选择已有仓库…</option>
          {allWorkspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="helios-workspace-strategy" disabled={locked || busy}>
        <legend>运行位置</legend>
        <label>
          <input
            type="radio"
            name="workspace-strategy"
            checked={selection.strategy === "direct"}
            onChange={() => onChange({ ...selection, strategy: "direct" })}
          />
          原仓库（默认）
        </label>
        <label title={git ? "在独立 Git worktree 中运行" : "仅 Git 仓库支持 worktree"}>
          <input
            data-testid="strategy-worktree"
            type="radio"
            name="workspace-strategy"
            checked={selection.strategy === "worktree"}
            disabled={!git || locked || busy}
            onChange={() => onChange({ ...selection, strategy: "worktree" })}
          />
          Worktree
        </label>
      </fieldset>

      {!locked ? (
        <div className="helios-workspace-sources">
          <button
            data-testid="select-directory"
            type="button"
            disabled={busy}
            onClick={() => void runAndSelect(onSelectDirectory)}
          >
            选择本地目录…
          </button>
          <label>
            <span>Git Clone（HTTPS / SSH）</span>
            <span className="helios-workspace-inline">
              <input
                value={remoteUrl}
                disabled={busy}
                placeholder="git@github.com:org/repo.git"
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || !remoteUrl.trim()}
                onClick={() => void runAndSelect(() => onClone(remoteUrl.trim()))}
              >
                Clone
              </button>
            </span>
          </label>
        </div>
      ) : (
        <span className="helios-workspace-locked">仓库已绑定；如需切换，请新建会话</span>
      )}
      {selection.strategy === "direct" && selected ? (
        <span className="helios-workspace-warning">Agent 将直接修改原仓库文件</span>
      ) : null}
      {error ? <span className="helios-workspace-error">{error}</span> : null}
    </div>
  );
}
