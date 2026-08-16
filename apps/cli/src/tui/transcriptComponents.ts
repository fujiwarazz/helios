import { Container, Markdown, Spacer, Text, type Component } from "@helios/tui";
import type { SessionViewState, ToolCardState, TranscriptMessage } from "./sessionViewModel";
import { HELIOS_MARKDOWN_THEME, palette } from "./theme";

const THINKING_PREVIEW_CHARS = 96;

const ROLE_LABEL: Record<TranscriptMessage["role"], string> = {
  user: "you",
  assistant: "helios",
  system: "·",
  toolResult: "tool",
};

const ROLE_STYLE: Record<TranscriptMessage["role"], (text: string) => string> = {
  user: palette.user,
  assistant: palette.assistant,
  system: palette.system,
  toolResult: palette.muted,
};

/**
 * One transcript entry rendered as persistent components: the same instances are mutated on
 * every delta so Markdown keeps its layout cache and the terminal only repaints changed lines.
 */
export class MessageComponent {
  readonly container = new Container();
  private readonly header = new Text("", 1, 0);
  private readonly thinking = new Text("", 2, 0);
  private readonly body: Markdown;
  private thinkingAttached = false;

  constructor(private readonly role: TranscriptMessage["role"]) {
    this.body = new Markdown("", 1, 0, HELIOS_MARKDOWN_THEME);
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.header);
    this.container.addChild(this.body);
    this.header.setText(ROLE_STYLE[this.role](`${ROLE_LABEL[this.role]} ›`));
  }

  update(message: TranscriptMessage, thinkingExpanded: boolean): void {
    this.body.setText(message.text);
    if (!message.thinking) {
      this.detachThinking();
      return;
    }
    this.thinking.setText(palette.muted(formatThinking(message.thinking, thinkingExpanded)));
    this.attachThinking();
  }

  /** Markdown body instance; identity is stable for the lifetime of the message. */
  get bodyComponent(): Markdown {
    return this.body;
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  private attachThinking(): void {
    if (this.thinkingAttached) return;
    this.thinkingAttached = true;
    // Keep reasoning above the answer so streamed text stays anchored at the bottom.
    this.container.children.splice(2, 0, this.thinking);
  }

  private detachThinking(): void {
    if (!this.thinkingAttached) return;
    this.thinkingAttached = false;
    this.container.removeChild(this.thinking);
  }
}

/** Compact tool card: label plus state, never the raw input or output body. */
export class ToolCardComponent {
  readonly container = new Container();
  private readonly line = new Text("", 1, 0);

  constructor() {
    this.container.addChild(this.line);
  }

  update(tool: ToolCardState): void {
    const label = tool.descriptor?.label ?? tool.name;
    const detail = tool.descriptor?.detail ? ` ${palette.muted(tool.descriptor.detail)}` : "";
    this.line.setText(`${statusIcon(tool.status)} ${label}${detail}`);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}

/**
 * Projection of `SessionViewState` onto retained components. Children are re-ordered on every
 * update, but the component instances are keyed by `messageId`/`toolUseId` and never rebuilt.
 */
export class TranscriptComponent implements Component {
  readonly container = new Container();
  private readonly messageList = new Container();
  private readonly toolList = new Container();
  private readonly messages = new Map<string, MessageComponent>();
  private readonly tools = new Map<string, ToolCardComponent>();
  private thinkingExpanded = false;

  constructor() {
    this.container.addChild(this.messageList);
    this.container.addChild(this.toolList);
  }

  update(state: Pick<SessionViewState, "messages" | "tools">): void {
    this.messageList.clear();
    for (const message of state.messages) {
      let component = this.messages.get(message.id);
      if (!component) {
        component = new MessageComponent(message.role);
        this.messages.set(message.id, component);
      }
      component.update(message, this.thinkingExpanded);
      this.messageList.addChild(component.container);
    }
    this.dropMissing(this.messages, state.messages.map((message) => message.id));

    this.toolList.clear();
    for (const tool of state.tools) {
      let component = this.tools.get(tool.toolUseId);
      if (!component) {
        component = new ToolCardComponent();
        this.tools.set(tool.toolUseId, component);
      }
      component.update(tool);
      this.toolList.addChild(component.container);
    }
    this.dropMissing(this.tools, state.tools.map((tool) => tool.toolUseId));
  }

  setThinkingExpanded(expanded: boolean): void {
    this.thinkingExpanded = expanded;
  }

  isThinkingExpanded(): boolean {
    return this.thinkingExpanded;
  }

  messageComponent(id: string): MessageComponent | undefined {
    return this.messages.get(id);
  }

  toolComponent(toolUseId: string): ToolCardComponent | undefined {
    return this.tools.get(toolUseId);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  private dropMissing(components: Map<string, unknown>, keep: readonly string[]): void {
    const alive = new Set(keep);
    for (const id of [...components.keys()]) {
      if (!alive.has(id)) components.delete(id);
    }
  }
}

function statusIcon(status: ToolCardState["status"]): string {
  if (status === "success") return palette.success("✔");
  if (status === "error") return palette.error("✖");
  return palette.accent("◐");
}

function formatThinking(thinking: string, expanded: boolean): string {
  if (expanded) return `thinking\n${thinking}`;
  const collapsed = thinking.replace(/\s+/g, " ").trim();
  const preview =
    collapsed.length > THINKING_PREVIEW_CHARS
      ? `…${collapsed.slice(-THINKING_PREVIEW_CHARS)}`
      : collapsed;
  return `thinking · ${preview}`;
}
