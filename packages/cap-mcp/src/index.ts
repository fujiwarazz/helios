import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CapabilityProvider, Tool, KernelContext, Logger } from "@helios/ports";
import { CAPABILITY_PROVIDER_API_VERSION } from "@helios/ports";

/**
 * @helios/cap-mcp —— CapabilityProvider 的 MCP 客户端实现（P2）。
 *
 * 通过 stdio 连接一个 MCP server，把它 list 出来的工具原样映射成 helios Tool，
 * 由 ToolRegistry 统一加上 `mcp:<server>` 前缀暴露给 agent。
 * 配置经 manifest.options 传入：{ server, command, args, env }。
 *
 * 降级：不加载 → 无外部 MCP 工具，其余照常。
 */
interface McpOptions {
  server?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

class McpCapability implements CapabilityProvider {
  readonly name: string;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private tools: McpToolDef[] = [];
  private logger: Logger | undefined;

  constructor(private readonly opts: McpOptions) {
    this.name = `mcp:${opts.server ?? "default"}`;
  }

  async activate(ctx: KernelContext): Promise<void> {
    this.logger = ctx.logger;
    this.transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
      env: this.opts.env,
    });
    this.client = new Client({ name: "helios", version: "0.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
    const res = await this.client.listTools();
    this.tools = res.tools as McpToolDef[];
    this.logger?.debug(`MCP ${this.name} 连接成功，工具数 ${this.tools.length}`);
  }

  getTools(): Tool[] {
    return this.tools.map((def) => this.toTool(def));
  }

  private toTool(def: McpToolDef): Tool {
    const client = () => this.client;
    return {
      name: def.name,
      description: def.description ?? `MCP 工具 ${def.name}`,
      inputSchema: (def.inputSchema as Tool["inputSchema"]) ?? {
        type: "object",
        properties: {},
      },
      execute: async (input) => {
        const c = client();
        if (!c) return { output: "MCP 客户端未连接", isError: true };
        try {
          const result = await c.callTool({
            name: def.name,
            arguments: (input as Record<string, unknown>) ?? {},
          });
          return { output: flattenContent(result.content), isError: !!result.isError };
        } catch (err) {
          return { output: err instanceof Error ? err.message : String(err), isError: true };
        }
      },
    };
  }

  async dispose(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

/** MCP 返回的 content 数组（text/其它块）压平成字符串。 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      return JSON.stringify(block);
    })
    .join("\n");
}

export const apiVersion = CAPABILITY_PROVIDER_API_VERSION;

export function create(ctx: KernelContext): CapabilityProvider {
  return new McpCapability((ctx.options ?? {}) as unknown as McpOptions);
}

export default { apiVersion, create };
