import { Box, Container, Markdown, Spacer, Text, type Component } from "@helios/tui";
import type { SessionViewState, ToolCardState, TranscriptMessage } from "./sessionViewModel";
import { HELIOS_MARKDOWN_THEME, palette } from "./theme";
import { formatElapsed, formatToolInput, formatToolOutput } from "./toolCardFormat";

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

/**
 * Tool card: a status header plus a filled block holding what the tool was called with, what it
 * printed, and how long it took.
 *
 * The body is a background-filled `Box` rather than a line-drawn border — same shape pi uses, and
 * `Box` already pads every row and applies the fill, so no new component is needed. Output is
 * collapsed to its tail by default because a single `Bash` call can print hundreds of lines.
 */
export class ToolCardComponent {
  readonly container = new Container();
  private readonly header = new Text("", 1, 0);
  private readonly body = new Box(1, 0, palette.toolCardBg);
  private readonly inputLine = new Text("", 0, 0);
  private readonly outputBlock = new Text("", 0, 0);
  private readonly footer = new Text("", 0, 0);
  private bodyAttached = false;

  constructor() {
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.header);
    this.body.addChild(this.inputLine);
    this.body.addChild(this.outputBlock);
    this.body.addChild(this.footer);
  }

  update(tool: ToolCardState, outputExpanded: boolean): void {
    const label = tool.descriptor?.label ?? tool.name;
    const detail = tool.descriptor?.detail ? ` ${palette.muted(tool.descriptor.detail)}` : "";
    this.header.setText(`${statusIcon(tool.status)} ${label}${detail}`);

    const input = formatToolInput(tool.name, tool.input);
    this.inputLine.setText(input ? palette.strong(`$ ${input}`) : "");

    const { lines, hiddenCount } = formatToolOutput(tool.output, outputExpanded);
    this.outputBlock.setText(lines.join("\n"));

    const notes: string[] = [];
    if (hiddenCount > 0) {
      notes.push(palette.muted(`… (${hiddenCount} earlier lines, ctrl+o to expand)`));
    }
    if (tool.endedAt !== undefined) {
      notes.push(palette.muted(`Took ${formatElapsed(tool.endedAt - tool.startedAt)}`));
    }
    this.footer.setText(notes.join("\n"));

    this.body.setBgFn(tool.isError ? palette.toolCardErrorBg : palette.toolCardBg);
    // A tool with no arguments and no output yet would render as an empty coloured band.
    this.setBodyAttached(Boolean(input) || lines.length > 0 || notes.length > 0);
  }

  render(width: number): string[] {
    return this.container.render(width);
  }

  private setBodyAttached(attached: boolean): void {
    if (attached === this.bodyAttached) return;
    this.bodyAttached = attached;
    if (attached) this.container.addChild(this.body);
    else this.container.removeChild(this.body);
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
  private readonly pending = new Container();
  private readonly messages = new Map<string, MessageComponent>();
  private readonly tools = new Map<string, ToolCardComponent>();
  private thinkingExpanded = false;
  private toolOutputExpanded = false;
  private pendingComponent?: Component;

  constructor() {
    this.container.addChild(this.messageList);
    this.container.addChild(this.toolList);
    // Last, so the pending indicator sits at the tail of the transcript where the reply will land.
    this.container.addChild(this.pending);
  }

  update(state: Pick<SessionViewState, "messages" | "tools">): void {
    this.messageList.clear();
    for (const message of state.messages) {
      // An assistant message with neither text nor reasoning has nothing to show but its label.
      // That happens while waiting for the first delta (the pending indicator covers that, and two
      // `helios ›` labels would be worse) and permanently when a run dies before producing output
      // — a 429 used to leave a bare, unexplained label behind, with the error on a separate line.
      if (message.role === "assistant" && !message.text && !message.thinking) continue;
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
      component.update(tool, this.toolOutputExpanded);
      this.toolList.addChild(component.container);
    }
    this.dropMissing(this.tools, state.tools.map((tool) => tool.toolUseId));
  }

  /**
   * Show a "reply is coming" indicator under the assistant's own label, or clear it with
   * `undefined`.
   *
   * It lives inside the transcript rather than below it so the `helios ›` label is present from the
   * moment the run starts: label + spinner → label + reasoning → label + answer, with the label
   * never moving. Previously the spinner sat outside the transcript and the label only appeared once
   * the first delta arrived, which read as "the label shows up late".
   */
  setPending(component?: Component): void {
    // Called on every frame; only rebuild when the indicator actually changes.
    if (component === this.pendingComponent) return;
    this.pendingComponent = component;
    this.pending.clear();
    if (!component) return;
    this.pending.addChild(new Spacer(1));
    this.pending.addChild(
      new Text(ROLE_STYLE.assistant(`${ROLE_LABEL.assistant} ›`), 1, 0),
    );
    this.pending.addChild(component);
  }

  setThinkingExpanded(expanded: boolean): void {
    this.thinkingExpanded = expanded;
  }

  isThinkingExpanded(): boolean {
    return this.thinkingExpanded;
  }

  setToolOutputExpanded(expanded: boolean): void {
    this.toolOutputExpanded = expanded;
  }

  isToolOutputExpanded(): boolean {
    return this.toolOutputExpanded;
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
