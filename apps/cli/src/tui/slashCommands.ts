/**
 * Local slash-command routing. Nothing here knows about the terminal implementation or the
 * Kernel: commands act through `SlashCommandHost`, so the interactive controller stays the only
 * place that owns session/view wiring.
 */

export interface ModelDescription {
  provider: string;
  model?: string;
  baseURL?: string;
}

export interface BranchChoice {
  leafId: string;
  depth: number;
  active: boolean;
}

export interface SlashCommandHost {
  /** A run is in flight; destructive commands must refuse instead of racing the agent. */
  isBusy(): boolean;
  /** Append a local, LLM-invisible line to the transcript. */
  notice(text: string): void;
  status(text: string): void;
  /** Drops the local projection only; Kernel messages/branches/persistence are untouched. */
  clearTranscript(): void;
  describeModel(): ModelDescription | undefined;
  listBranches(): readonly BranchChoice[];
  switchBranch(leafId: string): void;
  chooseBranch(choices: readonly BranchChoice[]): Promise<string | undefined>;
  /** Replaces the active persisted session in this process; rejects if unavailable. */
  resumeSession(sessionId: string): Promise<string>;
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export interface SlashCommandSpec {
  syntax: string;
  description: string;
}

export const SLASH_COMMANDS: Readonly<Record<string, SlashCommandSpec>> = {
  help: { syntax: "/help", description: "列出所有本地命令" },
  clear: { syntax: "/clear", description: "只清空本地 transcript，不动 Kernel 历史" },
  model: { syntax: "/model", description: "显示当前会话配置的 provider / model" },
  resume: { syntax: "/resume <session-id>", description: "在当前终端切换到另一个持久化会话" },
  tree: { syntax: "/tree", description: "列出消息树分支叶子并切换" },
};

/** `undefined` = ordinary prompt text that must reach the LLM unchanged. */
export function parseSlashCommand(input: string): ParsedCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.search(/\s/);
  const name = separator === -1 ? trimmed.slice(1) : trimmed.slice(1, separator);
  const args = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  return { name: name.toLowerCase(), args };
}

export async function runSlashCommand(
  command: ParsedCommand,
  host: SlashCommandHost,
): Promise<void> {
  switch (command.name) {
    case "help":
      host.notice(helpText());
      return;
    case "clear":
      host.clearTranscript();
      host.status("Cleared");
      return;
    case "model":
      showModel(host);
      return;
    case "tree":
      await switchBranch(host);
      return;
    case "resume":
      await resumeSession(command.args, host);
      return;
    default:
      host.notice(`未知命令 /${command.name}，输入 /help 查看可用命令`);
      host.status(`Unknown command: /${command.name}`);
      return;
  }
}

function helpText(): string {
  const lines = Object.values(SLASH_COMMANDS).map(
    (spec) => `  ${spec.syntax.padEnd(22)}${spec.description}`,
  );
  return ["可用命令（本地处理，不会发给模型）：", ...lines].join("\n");
}

function showModel(host: SlashCommandHost): void {
  const model = host.describeModel();
  if (!model) {
    host.notice("当前 manifest 未声明 LLMProvider，无法读取模型信息");
    return;
  }
  const lines = [
    `provider: ${model.provider}`,
    `model: ${model.model ?? "(provider 默认)"}`,
    ...(model.baseURL ? [`baseURL: ${model.baseURL}`] : []),
    "切换模型请改 helios.config.json 的 LLMProvider 配置后重启（运行时不改路由）。",
  ];
  host.notice(lines.join("\n"));
}

async function switchBranch(host: SlashCommandHost): Promise<void> {
  if (host.isBusy()) {
    host.status("Agent 正在运行，/tree 已忽略");
    return;
  }
  const choices = host.listBranches();
  if (choices.length === 0) {
    host.notice("当前会话还没有分支");
    return;
  }
  const leafId = await host.chooseBranch(choices);
  if (leafId === undefined) return;
  try {
    host.switchBranch(leafId);
  } catch (error) {
    host.status(`切换分支失败：${formatError(error)}`);
  }
}

async function resumeSession(args: string, host: SlashCommandHost): Promise<void> {
  if (!args) {
    host.status("用法：/resume <session-id>");
    return;
  }
  if (host.isBusy()) {
    host.status("Agent 正在运行，/resume 已忽略");
    return;
  }
  const sessionId = args.split(/\s+/)[0]!;
  host.status(`正在切换到会话 ${sessionId} …`);
  try {
    const resumed = await host.resumeSession(sessionId);
    host.status(`已切换到会话 ${resumed}`);
  } catch (error) {
    host.status(`resume 失败：${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
