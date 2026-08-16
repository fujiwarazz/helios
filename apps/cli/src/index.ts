import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AgentEvent, Manifest } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import { selectInteractiveMode } from "./interactiveMode";
import { CliUsageError, parseCliOptions } from "./options";
import { HeliosInteractiveView } from "./tui/heliosInteractiveView";
import { InteractiveCli } from "./tui/interactiveCli";
import type { ModelDescription } from "./tui/slashCommands";
import { createTuiLogger } from "./tui/tuiLogger";
import { openCliWorkspace, type CliWorkspaceRuntime } from "./workspaceRuntime";

const DEFAULT_MANIFEST: Manifest = {
  plugins: [
    { port: "FileSystemPort", package: "@helios/fs-node" },
    { port: "LLMProvider", package: "@helios/llm-openai", options: {} },
  ],
};

async function readManifest(workDir: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(resolve(workDir, "helios.config.json"), "utf8")) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return DEFAULT_MANIFEST;
  }
}

function resolveManifest(manifest: Manifest, workDir: string): Manifest {
  return {
    plugins: manifest.plugins.map((entry) => ({
      ...entry,
      package: resolvePluginPackage(entry.package, workDir),
    })),
  };
}

/** `/model` reports configuration only; runtime routing stays a manifest/Kernel concern. */
function describeManifestModel(manifest: Manifest): ModelDescription | undefined {
  const entry = manifest.plugins.find((plugin) => plugin.port === "LLMProvider");
  if (!entry) return undefined;
  const options = (entry.options ?? {}) as { model?: string; baseURL?: string };
  return { provider: entry.package, model: options.model, baseURL: options.baseURL };
}

function resolvePluginPackage(specifier: string, workDir: string): string {
  if (isAbsolute(specifier)) return specifier;
  if (specifier.startsWith(".")) return resolve(workDir, specifier);
  return import.meta.resolve(specifier);
}

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  const workDir = findManifestRoot(process.cwd());
  const declaredManifest = await readManifest(workDir);
  const manifest = resolveManifest(declaredManifest, workDir);
  const dataRoot = resolve(process.env.HELIOS_DATA_ROOT ?? join(homedir(), ".helios"));
  const gitTimeoutMs = parsePositiveInteger(process.env.HELIOS_GIT_TIMEOUT_MS);
  const mode = selectInteractiveMode({
    hasMessage: cli.message !== undefined,
    stdinIsTTY: stdin.isTTY,
    stdoutIsTTY: stdout.isTTY,
  });
  // In TUI mode the rendered frame owns stdout, so Kernel logs are routed into the transcript.
  const tuiLogger = mode === "tui" ? createTuiLogger() : undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let interactive: InteractiveCli | undefined;
  const abort = new AbortController();
  let runtime: CliWorkspaceRuntime | undefined;
  let stopping = false;

  const askQuestion = async (req: AskQuestionRequest): Promise<AskQuestionResponse> => {
    if (interactive) return interactive.askQuestion(req);
    rl ??= createInterface({ input: stdin, output: stdout });
    stdout.write(`\n${req.question}\n`);
    (req.options ?? []).forEach((option, index) => {
      stdout.write(
        `  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}\n`,
      );
    });
    const answer = await rl.question("> ");
    const index = Number(answer) - 1;
    return { answers: [req.options?.[index]?.label ?? answer.trim()] };
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    runtime?.bound.session.cancel();
    rl?.close();
    void interactive?.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    runtime = await openCliWorkspace({
      cli,
      cwd: workDir,
      dataRoot,
      manifest,
      askQuestion,
      signal: abort.signal,
      gitTimeoutMs,
      logger: tuiLogger,
    });
    const { bound } = runtime;
    const strategy = bound.binding.roots[0]?.strategy ?? "direct";
    stdout.write(
      `\nhelios CLI 就绪。${bound.binding.mode === "code" ? "Code" : "Chat"} workspace：${bound.binding.workspaceId} (${strategy})\n`,
    );
    stdout.write(`工具：${bound.kernel.listTools().join(", ")}\n`);
    if (cli.resume) {
      stdout.write(
        `已 resume 会话 ${bound.session.id}（历史消息 ${bound.session.getHistory().length} 条）\n`,
      );
    } else {
      stdout.write(`会话 id：${bound.session.id}（下次可用 --resume ${bound.session.id} 续聊）\n`);
    }
    if (mode === "tui") {
      interactive = new InteractiveCli({
        session: bound.session,
        view: new HeliosInteractiveView(),
        host: {
          describeModel: () => describeManifestModel(declaredManifest),
          resumeSession: async (sessionId) => (await runtime!.resumeSession(sessionId)).session,
        },
      });
      const cliRef = interactive;
      await interactive.start();
      tuiLogger?.attach((line) => cliRef.notice(line));
      await interactive.waitForExit();
      return;
    }

    bound.session.on((event: AgentEvent) => render(event));

    if (cli.message !== undefined) {
      await bound.session.sendMessage(cli.message);
      return;
    }

    rl ??= createInterface({ input: stdin, output: stdout });
    stdout.write("输入消息开始对话，Ctrl+C 退出。\n\n");
    while (!stopping) {
      let line: string;
      try {
        line = await rl.question("\nyou › ");
      } catch (error) {
        if (stopping) break;
        throw error;
      }
      if (!line.trim()) continue;
      try {
        await bound.session.sendMessage(line);
      } catch (error) {
        stdout.write(`\n[错误] ${formatError(error)}\n`);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    rl?.close();
    await runtime?.close();
  }
}

/** pnpm --filter runs this package from apps/cli; locate the user manifest above it. */
function findManifestRoot(startDir: string): string {
  const initialDir = resolve(startDir);
  let candidate = initialDir;
  while (true) {
    if (existsSync(join(candidate, "helios.config.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return initialDir;
    candidate = parent;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError("HELIOS_GIT_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function render(event: AgentEvent): void {
  switch (event.type) {
    case "message_start":
      if (event.role === "assistant") stdout.write("\nhelios › ");
      break;
    case "message_update":
      if (event.delta.type === "text-delta") stdout.write(event.delta.text);
      else if (event.delta.type === "tool-call-start") {
        stdout.write(`\n  ⚙ 调用工具 ${event.delta.name} …`);
      }
      break;
    case "tool_execution_end":
      stdout.write(event.isError ? "  [失败]\n" : "  [完成]\n");
      break;
    case "agent_end":
      stdout.write("\n");
      break;
    default:
      break;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof CliUsageError) {
      process.stderr.write(`helios: ${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`helios: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
