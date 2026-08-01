// ============================================================================
// packages/ui-chat/src/ChatView.tsx
// 极简对话组件:连接状态条 + 消息列表(气泡 + 工具卡片) + 输入框。
// 不做虚拟列表 / 分页 / 主题 —— 见 docs/three-client-status.md 待补清单。
// ============================================================================

import { useState } from "react";
import type { RenderTool } from "./useChat";
import { useChat } from "./useChat";
import type { IChatClient, ChatMessageView, ToolCallView } from "./types";

export interface ChatViewProps {
  client: IChatClient;
  renderTool?: RenderTool;
  placeholder?: string;
}

function ToolCard({ tool }: { tool: ToolCallView }): JSX.Element {
  const label = tool.descriptor?.label ?? tool.name;
  const statusDot =
    tool.status === "success" ? "●" : tool.status === "error" ? "✕" : "…";
  return (
    <div data-testid="tool-card" data-status={tool.status} className="helios-tool-card">
      <span className="helios-tool-status">{statusDot}</span>
      <span className="helios-tool-label">{label}</span>
      {tool.descriptor?.detail ? (
        <span className="helios-tool-detail">{tool.descriptor.detail}</span>
      ) : null}
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessageView }): JSX.Element {
  return (
    <div data-testid="message" data-role={msg.role} className={`helios-msg helios-msg-${msg.role}`}>
      {msg.text ? <div className="helios-msg-text">{msg.text}</div> : null}
      {msg.tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
    </div>
  );
}

export function ChatView({ client, renderTool, placeholder }: ChatViewProps): JSX.Element {
  const { messages, isStreaming, connection, send } = useChat(client, { renderTool });
  const [input, setInput] = useState("");

  const onSend = (): void => {
    const t = input.trim();
    if (!t) return;
    setInput("");
    void send(t);
  };

  return (
    <div className="helios-chat">
      {connection !== "open" ? (
        <div data-testid="connection-banner" data-state={connection} className="helios-conn-banner">
          {connection === "connecting" ? "连接中…" : "连接已断开"}
        </div>
      ) : null}

      <div data-testid="message-list" className="helios-msg-list">
        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
      </div>

      <div className="helios-input-row">
        <input
          data-testid="chat-input"
          className="helios-input"
          value={input}
          placeholder={placeholder ?? "输入消息…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          data-testid="send-button"
          className="helios-send"
          disabled={isStreaming || !input.trim()}
          onClick={onSend}
        >
          发送
        </button>
      </div>
    </div>
  );
}
