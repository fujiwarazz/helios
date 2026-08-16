import { execa } from "execa";
import { isIP } from "node:net";
import { convert as htmlToText } from "html-to-text";
import type { Tool, ToolContext, FileSystemPort, MultiAgentPort, PortRegistry } from "@helios/ports";

// 六件套 + WebFetch + AskUserQuestion。均通过 CapabilityProvider 注册路径接入，
// 仅在命名上豁免 provider 前缀（证明官方实现不走特权通道，只享命名豁免）。
//
// 工具都是工厂函数：只有真正要用 Port 的工具（Read/Write/Edit/Glob/Grep 用 fileSystem，
// Task 用 multiAgent）在被造出来的那一刻拿到具体实例、闭包持有；不需要 Port 的工具
// （Bash/WebFetch/AskUserQuestion）构造函数不接收任何 Port 参数。工具的 execute() 因此
// 物理上摸不到自己没被给的能力——不是"声明了就信任"的运行时校验，是结构上不存在
// （对齐 valos CodeAgent.initBuildinTools() / 本仓 capability-fs 的既有模式）。

const BASH_TIMEOUT_DEFAULT = 120_000;
const BASH_TIMEOUT_MAX = 600_000; // 硬上限，防 LLM 传超大 timeout 挂死
const WEBFETCH_TIMEOUT = 15_000;
const WEBFETCH_MAX_BYTES = 5 * 1024 * 1024; // 5MB，边读边截，不读全 body
const WEBFETCH_MAX_CHARS = 50_000; // 转纯文本后返回给模型的上限
const GREP_MAX_HITS = 200;

// 工具描述面向 LLM，用英文书写，且**只陈述本文件代码里真实存在的约束**（超时值、唯一性校验、
// 各类上限、SSRF 拒绝、Task 的异步语义）。不写"读取前必须先 Read"这类代码并未强制的规则——
// 那属于行为规范，放在 BASE_SYSTEM_PROMPT 的 `# Doing tasks` 里，避免描述承诺一个不存在的报错。

/** SSRF 防护：拒绝非 http(s)、以及指向本机/内网/云元数据的地址（字面 IP + localhost）。 */
export function assertFetchUrlAllowed(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`非法 URL：${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`仅允许 http/https：${u.protocol}`);
  }
  // 去方括号（IPv6）、去尾点（FQDN 规范化，如 "localhost."）。
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost") {
    throw new Error(`拒绝访问本机地址（SSRF 防护）：${host}`);
  }
  // 仅当 host 确为字面 IP 时才做私网/本机段判断，避免 "fd.example.com"、
  // "10.foo.com"、"fc-cdn.net" 等合法域名被前缀误伤。
  const kind = isIP(host); // 0=非IP，4=IPv4，6=IPv6
  if (kind === 4 && isPrivateIPv4(host)) {
    throw new Error(`拒绝访问本机/内网地址（SSRF 防护）：${host}`);
  }
  if (kind === 6 && isLocalIPv6(host)) {
    throw new Error(`拒绝访问本机/内网地址（SSRF 防护）：${host}`);
  }
}

function isPrivateIPv4(ip: string): boolean {
  return (
    ip === "0.0.0.0" ||
    ip === "169.254.169.254" || // 云元数据
    ip.startsWith("127.") || // 回环
    ip.startsWith("169.254.") || // link-local
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) // 172.16.0.0/12
  );
}

function isLocalIPv6(ip: string): boolean {
  return (
    ip === "::1" || // 回环
    ip === "::" ||
    ip.startsWith("fc") || // 唯一本地地址 fc00::/7
    ip.startsWith("fd") ||
    ip.startsWith("fe80") // link-local
  );
}

/** 边读边累加、达到上限即中止，避免大响应打满内存。 */
async function readCapped(resp: Response, maxBytes: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (received >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createBashTool(): Tool {
  return {
    name: "Bash",
    description: `Run one shell command in the working directory and return its stdout and stderr combined. A non-zero exit code is reported as an error.

Use a dedicated tool instead whenever one fits: Read to read a file, Edit or Write to change one, Grep to search contents, Glob to find paths. Those are more reliable here and let the user review the change.

Timeout defaults to ${BASH_TIMEOUT_DEFAULT / 1000}s and is capped at ${BASH_TIMEOUT_MAX / 1000}s. Quote paths containing spaces. Chain commands that depend on each other with \`&&\` in a single call; issue independent commands as separate parallel calls.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout: {
          type: "number",
          description: `Timeout in milliseconds. Defaults to ${BASH_TIMEOUT_DEFAULT}, capped at ${BASH_TIMEOUT_MAX}.`,
        },
      },
      required: ["command"],
    },
    async execute(input, ctx: ToolContext) {
      const { command, timeout } = input as { command: string; timeout?: number };
      // 已取消就不 spawn：execa 的 cancelSignal 只保证"运行中取消"，signal 在启动前就已
      // abort 时它仍会先起进程再杀，能否立刻回收取决于 Node/OS（Node 20 的 Linux runner 上
      // 会等满命令自身耗时）。这里直接短路，取消语义才与平台无关。
      if (ctx.signal?.aborted) {
        return { output: "命令已取消", isError: true };
      }
      // timeout 缺省或 <=0（含 0 会被 execa 解读为"永不超时"）时回落默认值，再夹到硬上限。
      const wanted = typeof timeout === "number" && timeout > 0 ? timeout : BASH_TIMEOUT_DEFAULT;
      const cappedTimeout = Math.min(wanted, BASH_TIMEOUT_MAX);
      try {
        const res = await execa(command, {
          shell: true,
          cwd: ctx.workDir,
          timeout: cappedTimeout,
          reject: false,
          cancelSignal: ctx.signal, // cancel 时中断命令（execa 9 起改名，旧名 signal）
        });
        const out = [res.stdout, res.stderr].filter(Boolean).join("\n");
        return { output: out || `(exit ${res.exitCode})`, isError: res.exitCode !== 0 };
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}

export function createReadTool(fileSystem: FileSystemPort): Tool {
  return {
    name: "Read",
    description: `Read a text file and return its full contents with line numbers prefixed. The whole file is returned — there is no pagination, so prefer Grep to locate what you need in a large file before reading it.

Paths may be absolute or relative to the working directory, and must stay inside it.`,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file, absolute or relative to the working directory.",
        },
      },
      required: ["file_path"],
    },
    async execute(input) {
      const { file_path } = input as { file_path: string };
      const content = await fileSystem.readFile(file_path);
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
        .join("\n");
      return { output: numbered };
    },
  };
}

export function createWriteTool(fileSystem: FileSystemPort): Tool {
  return {
    name: "Write",
    description: `Create a file, or replace an existing file's contents entirely. Missing parent directories are created automatically.

Prefer Edit when changing a file that already exists — Write replaces the whole file, so any content you did not restate is lost. Use Write for new files or a deliberate full rewrite. Do not create documentation or README files unless the user asked for them.`,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file, absolute or relative to the working directory.",
        },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["file_path", "content"],
    },
    fileMutations: (input) => [
      { path: (input as { file_path: string }).file_path, operationHint: "write" },
    ],
    async execute(input) {
      const { file_path, content } = input as { file_path: string; content: string };
      await fileSystem.writeFile(file_path, content);
      return { output: `已写入 ${file_path}` };
    },
  };
}

export function createEditTool(fileSystem: FileSystemPort): Tool {
  return {
    name: "Edit",
    description: `Replace an exact string in a file.

\`old_string\` must appear exactly once, or the call fails and nothing is written — include enough surrounding lines to make it unique rather than retrying with the same short string. Set \`replace_all\` to change every occurrence instead. \`old_string\` must not appear in the output of a previous Read with the line-number prefix still attached; match the file's real content, preserving its existing indentation exactly.`,
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file, absolute or relative to the working directory.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace. Must be unique in the file unless replace_all is set.",
        },
        new_string: { type: "string", description: "Text to replace it with." },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring a unique match.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    fileMutations: (input) => [
      { path: (input as { file_path: string }).file_path, operationHint: "edit" },
    ],
    async execute(input) {
      const { file_path, old_string, new_string, replace_all } = input as {
        file_path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      const content = await fileSystem.readFile(file_path);
      if (!content.includes(old_string)) {
        return { output: `未找到待替换字符串于 ${file_path}`, isError: true };
      }
      const count = content.split(old_string).length - 1;
      if (!replace_all && count > 1) {
        return { output: `old_string 出现 ${count} 次，非唯一；请提供更多上下文或用 replace_all`, isError: true };
      }
      const next = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);
      await fileSystem.writeFile(file_path, next);
      return { output: `已编辑 ${file_path}（替换 ${replace_all ? count : 1} 处）` };
    },
  };
}

export function createGlobTool(fileSystem: FileSystemPort): Tool {
  return {
    name: "Glob",
    description: `Find files by glob pattern, for example \`src/**/*.ts\` or \`**/package.json\`. Returns paths relative to the working directory, one per line.

Patterns are resolved from the working directory and must stay inside it — a pattern containing \`..\` is rejected. \`node_modules\` and \`.git\` are never matched, and dotfiles are skipped.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern relative to the working directory. Must not contain '..'.",
        },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const { pattern } = input as { pattern: string };
      const files = await fileSystem.glob(pattern);
      return { output: files.join("\n") || "(无匹配)" };
    },
  };
}

export function createGrepTool(fileSystem: FileSystemPort): Tool {
  return {
    name: "Grep",
    description: `Search file contents with a JavaScript regular expression, line by line. Each hit is returned as \`path:line:text\`.

Narrow the search with \`glob\` (defaults to \`**/*\`) — it is much faster than searching everything. Binary files, \`node_modules\`, \`.git\`, and dotfiles are skipped. At most ${GREP_MAX_HITS} hits are returned; if you reach that limit the result is incomplete, so tighten the pattern or the glob rather than reading the truncated list as the full answer.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        glob: {
          type: "string",
          description: "Restrict the search to files matching this glob. Defaults to '**/*'.",
        },
        ignore_case: { type: "boolean", description: "Match case-insensitively." },
      },
      required: ["pattern"],
    },
    async execute(input) {
      const { pattern, glob, ignore_case } = input as {
        pattern: string;
        glob?: string;
        ignore_case?: boolean;
      };
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : undefined);
      } catch (err) {
        return { output: `非法正则：${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      const files = await fileSystem.glob(glob ?? "**/*");
      const hits: string[] = [];
      for (const f of files) {
        let content: string;
        try {
          content = await fileSystem.readFile(f);
        } catch {
          continue;
        }
        if (content.includes("\u0000")) continue; // 跳过二进制文件（含 NUL 字节），避免乱码匹配 + DoS
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) hits.push(`${f}:${i + 1}:${lines[i]}`);
          if (hits.length >= GREP_MAX_HITS) break;
        }
        if (hits.length >= GREP_MAX_HITS) break;
      }
      return { output: hits.join("\n") || "(无匹配)" };
    },
  };
}

export function createWebFetchTool(): Tool {
  return {
    name: "WebFetch",
    description: `Fetch an http or https URL and return the page converted from HTML to plain text, truncated to ${WEBFETCH_MAX_CHARS} characters. Redirects are followed; the request times out after ${WEBFETCH_TIMEOUT / 1000}s.

Requests to localhost, loopback, private-range, link-local, and cloud metadata addresses are refused. Only fetch URLs the user gave you or that you found in the repository — do not guess or construct URLs.`,
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http or https URL." } },
      required: ["url"],
    },
    async execute(input, ctx: ToolContext) {
      const { url } = input as { url: string };
      try {
        assertFetchUrlAllowed(url); // SSRF：拒绝内网/本机/云元数据
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      }
      // 超时（15s）+ 组合外部 cancel 信号
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), WEBFETCH_TIMEOUT);
      const signals = [timer.signal, ctx.signal].filter(Boolean) as AbortSignal[];
      const signal = typeof (AbortSignal as unknown as { any?: unknown }).any === "function"
        ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any(signals)
        : timer.signal;
      try {
        const resp = await fetch(url, { redirect: "follow", signal });
        const html = await readCapped(resp, WEBFETCH_MAX_BYTES); // 边读边截，防内存打满
        const text = htmlToText(html, { wordwrap: false });
        return { output: text.slice(0, WEBFETCH_MAX_CHARS) };
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

export function createAskQuestionTool(): Tool {
  return {
    name: "AskUserQuestion",
    description: `Ask the user a question and return their answer.

Use this when the requirement is ambiguous, or when you must choose between approaches with materially different outcomes and the codebase does not settle the choice. Supply 2-4 concrete options when there are distinct alternatives; the user can always answer freely instead.

Do not use it for anything you can determine by reading the code, and do not use it to ask for permission to continue work you were already asked to do.`,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, specific and self-contained." },
        options: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional distinct choices, each { label, description }. Omit for an open question.",
        },
      },
      required: ["question"],
    },
    async execute(input, ctx: ToolContext) {
      const { question, options } = input as {
        question: string;
        options?: { label: string; description?: string }[];
      };
      const res = await ctx.askQuestion({ question, options });
      return { output: res.answers.join(", ") };
    },
  };
}

export function createTaskTool(multiAgent: MultiAgentPort): Tool {
  return {
    name: "Task",
    description: `Hand a self-contained task to a teammate agent that works independently. Requires the multi-agent capability; returns an error when it is not enabled.

This call only dispatches the task and returns immediately — it does NOT return the teammate's result. The teammate replies later through the mailbox, so do not wait on this tool's output for an answer, and do not dispatch work you need before your next step.

The teammate cannot see this conversation. Describe the task completely: what to do, which files or paths matter, and what a finished result looks like.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Teammate name or role. Defaults to 'teammate'.",
        },
        description: {
          type: "string",
          description:
            "The complete, self-contained task. The teammate has no access to this conversation.",
        },
      },
      required: ["description"],
    },
    async execute(input) {
      const { name, description } = input as { name?: string; description: string };
      const agentName = name ?? "teammate";
      try {
        const handle = await multiAgent.spawn({ name: agentName, prompt: description });
        await multiAgent.send(handle, {
          from: "leader",
          to: handle.name,
          type: "assign",
          payload: { task: description },
          ts: Date.now(),
        });
        return { output: `已派发任务给 teammate「${handle.name}」` };
      } catch (err) {
        return {
          output: `多智能体能力未启用或派发失败：${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/** 组装全部六件套 + WebFetch + AskUserQuestion + Task，按需把具体 Port 实例闭包进各自工具。 */
export function createBuiltinTools(ports: PortRegistry): Tool[] {
  return [
    createBashTool(),
    createReadTool(ports.fileSystem),
    createWriteTool(ports.fileSystem),
    createEditTool(ports.fileSystem),
    createGlobTool(ports.fileSystem),
    createGrepTool(ports.fileSystem),
    createWebFetchTool(),
    createAskQuestionTool(),
    createTaskTool(ports.multiAgent),
  ];
}
