import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { CapabilityProvider, Tool, KernelContext, Logger } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/**
 * @helios/cap-lsp —— CapabilityProvider 的 LSP 实现（P2）。
 *
 * spawn `typescript-language-server --stdio`，用 vscode-jsonrpc 建 LSP 连接，
 * 暴露 lsp_definition / lsp_hover 两个工具。file_path 相对 workDir 解析。
 * 配置经 manifest.options 传入：{ command?, args?, languageId? }。
 *
 * 降级：不加载 → 无 LSP 能力，其余照常。
 */
interface LspOptions {
  command?: string;
  args?: string[];
  languageId?: string;
}

interface Position {
  line: number;
  character: number;
}

class LspCapability implements CapabilityProvider {
  readonly name = "lsp";
  private proc: ChildProcessWithoutNullStreams | undefined;
  private conn: MessageConnection | undefined;
  private readonly opened = new Set<string>();
  private logger: Logger | undefined;
  private workDir = process.cwd();

  constructor(private readonly opts: LspOptions) {}

  async activate(ctx: KernelContext): Promise<void> {
    this.logger = ctx.logger;
    this.workDir = ctx.workDir;
    const command = this.opts.command ?? "typescript-language-server";
    const args = this.opts.args ?? ["--stdio"];
    this.proc = spawn(command, args, { cwd: this.workDir }) as ChildProcessWithoutNullStreams;
    this.conn = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );
    this.conn.listen();
    await this.conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.workDir).href,
      capabilities: {},
    });
    this.conn.sendNotification("initialized", {});
    this.logger?.debug(`LSP ${command} 已初始化`);
  }

  getTools(): Tool[] {
    return [this.queryTool("definition", "textDocument/definition"), this.queryTool("hover", "textDocument/hover")];
  }

  private uriFor(filePath: string): string {
    const abs = isAbsolute(filePath) ? filePath : resolve(this.workDir, filePath);
    return pathToFileURL(abs).href;
  }

  /** 首次查询前 didOpen 该文档，让 server 载入内容。 */
  private async ensureOpen(filePath: string): Promise<string> {
    const uri = this.uriFor(filePath);
    if (!this.opened.has(uri)) {
      const abs = isAbsolute(filePath) ? filePath : resolve(this.workDir, filePath);
      const text = await readFile(abs, "utf8");
      this.conn?.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: this.opts.languageId ?? "typescript", version: 1, text },
      });
      this.opened.add(uri);
    }
    return uri;
  }

  private queryTool(toolName: string, lspMethod: string): Tool {
    return {
      name: toolName,
      description: `LSP ${lspMethod}：给定文件与光标位置返回结果。`,
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          line: { type: "number", description: "0 基行号" },
          character: { type: "number", description: "0 基列号" },
        },
        required: ["file_path", "line", "character"],
      },
      execute: async (input) => {
        const { file_path, line, character } = input as { file_path: string } & Position;
        if (!this.conn) return { output: "LSP 未连接", isError: true };
        try {
          const uri = await this.ensureOpen(file_path);
          const result = await this.conn.sendRequest(lspMethod, {
            textDocument: { uri },
            position: { line, character },
          });
          return { output: JSON.stringify(result ?? null) };
        } catch (err) {
          return { output: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    };
  }

  async dispose(): Promise<void> {
    try {
      await this.conn?.sendRequest("shutdown");
      this.conn?.sendNotification("exit");
    } catch {
      // server 可能已退出，忽略
    }
    this.conn?.dispose();
    this.proc?.kill();
    this.conn = undefined;
    this.proc = undefined;
    this.opened.clear();
  }
}

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): CapabilityProvider {
  return new LspCapability((ctx.options ?? {}) as LspOptions);
}

export default { apiVersion, create };
