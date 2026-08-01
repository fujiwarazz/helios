// apps/web/src/App.tsx —— 浏览器客户端外壳。client 可注入(便于测试),默认连 WS 宿主。
import { useMemo } from "react";
import type { ToolStatus } from "@helios/ports";
import { ChatView, RpcChatClient, type IChatClient } from "@helios/ui-chat";
import { RpcClient, browserWsClientTransport } from "@helios/protocol/browser";

/** 默认从 ?ws= 读宿主地址,缺省 ws://localhost:8787。 */
function defaultWsUrl(): string {
  const q = new URLSearchParams(window.location.search).get("ws");
  return q ?? "ws://localhost:8787";
}

/** 极简工具渲染:工具名 + 状态。 */
function renderTool(name: string, _input: unknown, status: ToolStatus) {
  return { label: name, status };
}

export function App({ client }: { client?: IChatClient }): JSX.Element {
  const chatClient = useMemo<IChatClient>(() => {
    if (client) return client;
    const rpc = new RpcClient(() => browserWsClientTransport(defaultWsUrl()));
    return new RpcChatClient(rpc);
  }, [client]);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <ChatView client={chatClient} renderTool={renderTool} />
    </div>
  );
}
