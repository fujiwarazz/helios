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
    description: "在工作目录执行一条 shell 命令，返回 stdout/stderr。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
        timeout: { type: "number", description: "超时毫秒，默认 120000" },
      },
      required: ["command"],
    },
    async execute(input, ctx: ToolContext) {
      const { command, timeout } = input as { command: string; timeout?: number };
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
    description: "读取文件内容（带行号）。",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
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
    description: "写入（覆盖）文件内容。",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" }, content: { type: "string" } },
      required: ["file_path", "content"],
    },
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
    description: "在文件中做精确字符串替换。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
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
    description: "按 glob 模式匹配文件路径。",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
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
    description: "在文件内容中做正则搜索（纯 JS 行级匹配）。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "限定文件的 glob，默认 **/*" },
        ignore_case: { type: "boolean" },
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
          if (hits.length >= 200) break;
        }
        if (hits.length >= 200) break;
      }
      return { output: hits.join("\n") || "(无匹配)" };
    },
  };
}

export function createWebFetchTool(): Tool {
  return {
    name: "WebFetch",
    description: "抓取一个 URL 并将 HTML 转为纯文本返回。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
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
        return { output: text.slice(0, 50_000) };
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
    description: "向用户提问以澄清需求，返回用户的选择。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "object" },
          description: "可选项 [{label, description}]",
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
    description: "派生一个 teammate 子智能体并派发任务（依赖 MultiAgentPort，未启用时返回错误）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "teammate 名称/角色，默认 teammate" },
        description: { type: "string", description: "要交给 teammate 的任务描述" },
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
