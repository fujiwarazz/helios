export interface CliOptions {
  message?: string;
  resume?: string;
  codePath?: string;
  cloneUrl?: string;
  workspaceId?: string;
  legacyWorkDir?: string;
  worktree: boolean;
}

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const VALUE_FLAGS = new Map<string, keyof Omit<CliOptions, "worktree">>([
  ["--message", "message"],
  ["--resume", "resume"],
  ["--code", "codePath"],
  ["--clone", "cloneUrl"],
  ["--workspace", "workspaceId"],
  ["--legacy-workdir", "legacyWorkDir"],
]);

export function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { worktree: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--worktree") {
      if (options.worktree) throw new CliUsageError("--worktree specified more than once");
      options.worktree = true;
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
  if (options.worktree && codeSources.length === 0) {
    throw new CliUsageError("--worktree requires a Code source");
  }
  if (options.legacyWorkDir && !options.resume) {
    throw new CliUsageError("--legacy-workdir requires --resume");
  }
  return options;
}
