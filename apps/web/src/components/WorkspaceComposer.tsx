import { useState } from "react";
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
  localImportEnabled?: boolean;
  onChange(selection: WorkspaceSelection): void;
  onClone(remoteUrl: string): Promise<WorkspaceSummary | undefined>;
  onImportLocal?(path: string): Promise<WorkspaceSummary | undefined>;
}

export function WorkspaceComposer({
  workspaces,
  selection,
  locked = false,
  localImportEnabled = false,
  onChange,
  onClone,
  onImportLocal,
}: WorkspaceComposerProps): JSX.Element {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected = workspaces.find((workspace) => workspace.id === selection.workspaceId);
  const git = selected?.roots.find((root) => root.id === selection.rootId)?.git ?? false;

  const selectWorkspace = (workspaceId: string): void => {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
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
          {workspaces.map((workspace) => (
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
            value="direct"
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
            value="worktree"
            checked={selection.strategy === "worktree"}
            disabled={!git || locked || busy}
            onChange={() => onChange({ ...selection, strategy: "worktree" })}
          />
          Worktree
        </label>
      </fieldset>

      {!locked ? (
        <div className="helios-workspace-sources">
          <label>
            <span>Git Clone（HTTPS / SSH）</span>
            <span className="helios-workspace-inline">
              <input
                data-testid="clone-url-input"
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
          {localImportEnabled && onImportLocal ? (
            <label>
              <span>Host 可访问目录</span>
              <span className="helios-workspace-inline">
                <input
                  data-testid="local-path-input"
                  value={localPath}
                  disabled={busy}
                  placeholder="/path/on/web-host"
                  onChange={(event) => setLocalPath(event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !localPath.trim()}
                  onClick={() => void runAndSelect(() => onImportLocal(localPath.trim()))}
                >
                  导入
                </button>
              </span>
            </label>
          ) : null}
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
