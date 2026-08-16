export interface CliOptions {
  message?: string;
  resume?: string;
  codePath?: string;
  cloneUrl?: string;
  workspaceId?: string;
  legacyWorkDir?: string;
  worktree: boolean;
  /** Opt out of the default Code mode and start a managed Chat workspace instead. */
  chat: boolean;
}

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const VALUE_FLAGS = new Map<string, keyof Omit<CliOptions, "worktree" | "chat">>([
  ["--message", "message"],
  ["--resume", "resume"],
  ["--code", "codePath"],
  ["--clone", "cloneUrl"],
  ["--workspace", "workspaceId"],
  ["--legacy-workdir", "legacyWorkDir"],
]);

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { worktree: false, chat: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--worktree") {
      if (options.worktree) throw new CliUsageError("--worktree specified more than once");
      options.worktree = true;
      continue;
    }
    if (argument === "--chat") {
      if (options.chat) throw new CliUsageError("--chat specified more than once");
      options.chat = true;
      continue;
    }
    const key = VALUE_FLAGS.get(argument);
    if (!key) throw new CliUsageError(`unknown option: ${argument}`);
    if (options[key] !== undefined) {
      throw new CliUsageError(`${argument} specified more than once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`${argument} requires a value`);
    }
    options[key] = value;
    index += 1;
  }

  const codeSources = [options.codePath, options.cloneUrl, options.workspaceId].filter(
    (value) => value !== undefined,
  );
  if (codeSources.length > 1) {
    throw new CliUsageError("only one of --code, --clone, or --workspace may be used");
  }
  if (options.resume && codeSources.length > 0) {
    throw new CliUsageError("--resume cannot be combined with --code, --clone, or --workspace");
  }
  // Code mode is the default, so --worktree needs no explicit source; only Chat and resume conflict.
  if (options.worktree && (options.chat || options.resume)) {
    throw new CliUsageError("--worktree cannot be combined with --chat or --resume");
  }
  if (options.chat && (codeSources.length > 0 || options.resume)) {
    throw new CliUsageError("--chat cannot be combined with --code, --clone, --workspace, or --resume");
  }
  if (options.legacyWorkDir && !options.resume) {
    throw new CliUsageError("--legacy-workdir requires --resume");
  }
  return options;
}
