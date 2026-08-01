// 最小 MCP stdio server：注册一个 echo 工具，供 cap-mcp 集成测试连接。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "0.0.0" });

server.tool("echo", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));

await server.connect(new StdioServerTransport());
