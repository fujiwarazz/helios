// ============================================================================
// packages/ui-chat/src/ChatView.tsx
// 对话组件:连接状态条 + 消息列表(思考块 + 气泡/markdown + 工具卡片 + run 级回溯入口)
// + 审批卡片 + 多行输入(Enter 发送 / Shift+Enter 换行)+ 发送/停止。
// ============================================================================

import { useRef, useState, type ReactNode } from "react";
import type { RenderTool } from "./useChat";
import { useChat } from "./useChat";
import { Markdown } from "./Markdown";
import type { IChatClient, ChatMessageView, ToolCallView, AskQuestion } from "./types";

export interface ChatViewProps {
  client: IChatClient;
  renderTool?: RenderTool;
  placeholder?: string;
  examplePrompts?: string[];
  composerHeader?: ReactNode;
  canSubmit?: boolean;
  onBeforeSubmit?: (text: string) => void | Promise<void>;
  onFirstSubmitted?: () => void;
  onSubmitFailed?: () => void | Promise<void>;
  rollbackMode?: "full" | "conversation-only";
}

const DEFAULT_EXAMPLES = [
  "帮我分析一下当前代码仓库",
  "把这个函数重构得更清晰",
  "这段逻辑是做什么的?",
];

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 通用审计详情：即使工具没有专属 renderer，也始终可以查看其实际入参与输出。 */
function genericToolDetail(tool: ToolCallView): string | undefined {
  const sections: string[] = [];
  if (tool.input !== undefined) sections.push(`输入参数\n${formatToolValue(tool.input)}`);
  if (tool.output !== undefined) sections.push(`输出内容\n${formatToolValue(tool.output)}`);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function ToolCard({ tool }: { tool: ToolCallView }): JSX.Element {
  const [open, setOpen] = useState(false);
  const label = tool.descriptor?.label ?? tool.name;
  const detail = [tool.descriptor?.detail, genericToolDetail(tool)].filter(Boolean).join("\n\n") || undefined;
  const expandable = !!detail;
  const statusDot =
    tool.status === "success" ? "●" : tool.status === "error" ? "✕" : "•";
  return (
    <div data-testid="tool-card" data-status={tool.status} className="helios-tool-card">
      <button
        type="button"
        className="helios-tool-head"
        data-expandable={expandable ? "true" : "false"}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <span className="helios-tool-status">{statusDot}</span>
        <span className="helios-tool-label">{label}</span>
        {expandable ? <span className="helios-tool-caret">{open ? "▾" : "▸"}</span> : null}
      </button>
      {expandable && open ? <pre className="helios-tool-detail">{detail}</pre> : null}
    </div>
  );
}

function MessageBubble({
  msg,
  streaming,
  canRollback,
  onRollback,
  rollbackMode,
}: {
  msg: ChatMessageView;
  streaming: boolean;
  canRollback: boolean;
  onRollback: (turnId: string) => void;
  rollbackMode: "full" | "conversation-only";
}): JSX.Element {
  const isAssistant = msg.role === "assistant";
  const showCursor = streaming && isAssistant;
  const showRollback =
    canRollback && isAssistant && msg.isRunBoundary && !!msg.rollbackTurnId;

  return (
    <div data-testid="message" data-role={msg.role} className={`helios-msg helios-msg-${msg.role}`}>
      {isAssistant && msg.thinking ? (
        <details data-testid="thinking-block" className="helios-thinking">
          <summary className="helios-thinking-summary">💭 思考过程</summary>
          <div className="helios-thinking-body">{msg.thinking}</div>
        </details>
      ) : null}
      {msg.text ? (
        <div className="helios-msg-text">
          {/* assistant 全程 markdown 渲染(含流式);user 恒纯文本。 */}
          {isAssistant ? <Markdown>{msg.text}</Markdown> : msg.text}
          {showCursor ? <span className="helios-cursor" aria-hidden /> : null}
        </div>
      ) : showCursor ? (
        <div className="helios-msg-text">
          <span className="helios-cursor" aria-hidden />
        </div>
      ) : null}

      {msg.tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}

      {showRollback ? (
        <div className="helios-turn-boundary">
          <span className="helios-turn-dot" aria-hidden />
          <button
            data-testid="rollback-button"
            className="helios-rollback"
            type="button"
            title={
              rollbackMode === "conversation-only"
                ? "回退对话，不修改文件"
                : "丢弃此处之后的对话,回到这个检查点重新开始"
            }
            onClick={() => {
              const prompt =
                rollbackMode === "conversation-only"
                  ? "回退对话，不修改文件？此后的对话将被丢弃。"
                  : "回到这个检查点?此后的对话将被丢弃(可从这里重聊)。";
              if (window.confirm(prompt)) {
                onRollback(msg.rollbackTurnId!);
              }
            }}
          >
            ⟲ 从这里重新开始
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  prompts,
  onPick,
}: {
  prompts: string[];
  onPick: (text: string) => void;
}): JSX.Element {
  return (
    <div data-testid="empty-state" className="helios-empty">
      <div className="helios-empty-title">开始一段对话</div>
      <div className="helios-empty-sub">试试这些,或直接输入你的问题</div>
      <div className="helios-empty-prompts">
        {prompts.map((p) => (
          <button key={p} type="button" className="helios-empty-prompt" onClick={() => onPick(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 审批卡片:渲染 AskUserQuestion 的问题 + 选项,用户点选后回传答案。 */
function ApprovalCard({
  question,
  onAnswer,
}: {
  question: AskQuestion;
  onAnswer: (questionId: string, answers: string[]) => void | Promise<void>;
}): JSX.Element {
  const [picked, setPicked] = useState<string[]>([]);
  const options = question.options ?? [];
  const multi = !!question.multiSelect;

  const toggle = (label: string): void => {
    if (!multi) {
      void onAnswer(question.questionId, [label]); // 单选:点击即提交
      return;
    }
    setPicked((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));
  };

  return (
    <div data-testid="approval-card" className="helios-approval">
      {question.header ? <div className="helios-approval-header">{question.header}</div> : null}
      <div className="helios-approval-question">{question.question}</div>
      {options.length > 0 ? (
        <div className="helios-approval-options">
          {options.map((opt) => {
            const on = picked.includes(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                data-testid="approval-option"
                data-selected={multi && on ? "true" : "false"}
                className="helios-approval-option"
                onClick={() => toggle(opt.label)}
              >
                <span className="helios-approval-option-label">{opt.label}</span>
                {opt.description ? (
                  <span className="helios-approval-option-desc">{opt.description}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="helios-approval-options">
          <button
            type="button"
            data-testid="approval-option"
            className="helios-approval-option"
            onClick={() => void onAnswer(question.questionId, ["允许"])}
          >
            <span className="helios-approval-option-label">允许</span>
          </button>
        </div>
      )}
      {multi ? (
        <button
          type="button"
          data-testid="approval-submit"
          className="helios-approval-submit"
          disabled={picked.length === 0}
          onClick={() => void onAnswer(question.questionId, picked)}
        >
          提交所选({picked.length})
        </button>
      ) : null}
    </div>
  );
}

export function ChatView({
  client,
  renderTool,
  placeholder,
  examplePrompts,
  composerHeader,
  canSubmit = true,
  onBeforeSubmit,
  onFirstSubmitted,
  onSubmitFailed,
  rollbackMode = "full",
}: ChatViewProps): JSX.Element {
  const {
    messages,
    isStreaming,
    isCompacting,
    connection,
    send,
    stop,
    rollback,
    canStop,
    canRollback,
    pendingQuestion,
    answer,
  } = useChat(client, { renderTool });
  const [input, setInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const firstSubmittedRef = useRef(false);

  const onSend = async (): Promise<void> => {
    const t = input.trim();
    if (!t || !canSubmit || isStreaming || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onBeforeSubmit?.(t);
      const sent = await send(t);
      if (!sent) {
        await onSubmitFailed?.();
        return;
      }
      setInput("");
      if (!firstSubmittedRef.current) {
        firstSubmittedRef.current = true;
        onFirstSubmitted?.();
      }
    } catch {
      // The caller owns pre-submit error presentation. Keeping the input lets the
      // user correct the workspace selection or retry without retyping.
      await onSubmitFailed?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const fillPrompt = (text: string): void => {
    setInput(text);
    taRef.current?.focus();
  };

  return (
    <div className="helios-chat">
      {connection !== "open" ? (
        <div data-testid="connection-banner" data-state={connection} className="helios-conn-banner">
          {connection === "connecting" ? "连接中…" : "连接已断开"}
        </div>
      ) : null}

      {isCompacting ? (
        <div data-testid="compacting-banner" className="helios-compacting-banner">
          正在整理历史记录…
        </div>
      ) : null}

      <div data-testid="message-list" className="helios-msg-list">
        {messages.length === 0 && !pendingQuestion ? (
          <EmptyState prompts={examplePrompts ?? DEFAULT_EXAMPLES} onPick={fillPrompt} />
        ) : (
          messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              msg={m}
              streaming={isStreaming && i === messages.length - 1}
              canRollback={canRollback}
              onRollback={(turnId) => void rollback(turnId)}
              rollbackMode={rollbackMode}
            />
          ))
        )}
        {pendingQuestion ? (
          <ApprovalCard question={pendingQuestion} onAnswer={answer} />
        ) : null}
      </div>

      <div className="helios-composer">
        {composerHeader ? <div className="helios-composer-header">{composerHeader}</div> : null}
        <div className="helios-input-row">
          <textarea
            ref={taRef}
            data-testid="chat-input"
            className="helios-input"
            rows={1}
            value={input}
            placeholder={placeholder ?? "输入消息…(Enter 发送 / Shift+Enter 换行)"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
          {isStreaming && canStop ? (
            <button
              data-testid="stop-button"
              className="helios-send helios-stop"
              type="button"
              onClick={() => void stop()}
            >
              停止
            </button>
          ) : (
            <button
              data-testid="send-button"
              className="helios-send"
              type="button"
              disabled={!canSubmit || isStreaming || isSubmitting || !input.trim()}
              onClick={() => void onSend()}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
