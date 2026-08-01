import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Kernel, type Manifest, type AgentEvent } from "@helios/kernel";
import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";

const DEFAULT_MANIFEST: Manifest = {
  plugins: [
    { port: "FileSystemPort", package: "@helios/fs-node" },
    { port: "LLMProvider", package: "@helios/llm-anthropic", options: {} },
  ],
};

async function loadManifest(workDir: string): Promise<Manifest> {
  try {
    const raw = await readFile(resolve(workDir, "helios.config.json"), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return DEFAULT_MANIFEST;
  }
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return undefined;
}

async function main(): Promise<void> {
  const workDir = process.cwd();
  const manifest = await loadManifest(workDir);
  const argv = process.argv.slice(2);
  const oneShot = parseFlag(argv, "--message");
  const resumeId = parseFlag(argv, "--resume");
  const rl = createInterface({ input: stdin, output: stdout });

  const askQuestion = async (req: AskQuestionRequest): Promise<AskQuestionResponse> => {
    stdout.write(`\n${req.question}\n`);
    (req.options ?? []).forEach((o, i) => {
      stdout.write(`  ${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}\n`);
    });
    const ans = await rl.question("> ");
    const idx = Number(ans) - 1;
    const picked = req.options?.[idx]?.label ?? ans.trim();
    return { answers: [picked] };
  };

  const kernel = new Kernel({
    workDir,
    manifest,
    llmOptions: { provider: "anthropic" },
    // 裸包名从 CLI 自身依赖解析（manifest 里的 @helios/* 是 CLI 的 workspace 依赖）。
    resolvePackage: (spec) => import.meta.resolve(spec),
  });
  await kernel.start();
  stdout.write(`\nhelios CLI 就绪。工具：${kernel.listTools().join(", ")}\n`);

  const session = resumeId
    ? await kernel.resumeSession(resumeId, { askQuestion })
    : kernel.createSession({ askQuestion });
  if (resumeId) {
    stdout.write(`已 resume 会话 ${session.id}（历史消息 ${session.getHistory().length} 条）\n`);
  } else {
    stdout.write(`会话 id：${session.id}（下次可用 --resume ${session.id} 续聊）\n`);
  }
  session.on((ev: AgentEvent) => render(ev));

  // 非交互 one-shot 模式：跑一轮 run 后退出（供脚本 / e2e 使用）
  if (oneShot !== undefined) {
    try {
      await session.sendMessage(oneShot);
      rl.close();
      process.exit(0);
    } catch (err) {
      stdout.write(`\n[错误] ${err instanceof Error ? err.message : String(err)}\n`);
      rl.close();
      process.exit(1);
    }
  }

  stdout.write("输入消息开始对话，Ctrl+C 退出。\n\n");
  while (true) {
    const line = await rl.question("\nyou › ");
    if (!line.trim()) continue;
    try {
      await session.sendMessage(line);
    } catch (err) {
      stdout.write(`\n[错误] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

function render(ev: AgentEvent): void {
  switch (ev.type) {
    case "message_start":
      if (ev.role === "assistant") stdout.write("\nhelios › ");
      break;
    case "message_update":
      if (ev.delta.type === "text-delta") stdout.write(ev.delta.text);
      else if (ev.delta.type === "tool-call-start") stdout.write(`\n  ⚙ 调用工具 ${ev.delta.name} …`);
      break;
    case "tool_execution_end":
      stdout.write(ev.isError ? "  [失败]\n" : "  [完成]\n");
      break;
    case "agent_end":
      stdout.write("\n");
      break;
    default:
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
