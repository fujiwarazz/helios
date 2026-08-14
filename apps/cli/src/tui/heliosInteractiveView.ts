import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import {
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  type EditorTheme,
  type TUI,
} from "@helios/tui";
import { askApproval, type ApprovalOverlayHost } from "./approvalOverlay";
import type { InteractiveView } from "./interactiveCli";
import type { SessionViewState } from "./sessionViewModel";

const IDENTITY = (value: string): string => value;
const EDITOR_THEME: EditorTheme = {
  borderColor: IDENTITY,
  selectList: {
    selectedPrefix: IDENTITY,
    selectedText: IDENTITY,
    description: IDENTITY,
    scrollInfo: IDENTITY,
    noMatch: IDENTITY,
  },
};

export class HeliosInteractiveView implements InteractiveView, ApprovalOverlayHost {
  private readonly ui: TUI;
  private readonly document = new Container();
  private readonly transcript = new Container();
  private readonly tools = new Container();
  private readonly status = new Text("Ready", 0, 0);
  private readonly editor: Editor;
  private submit?: (text: string) => void;
  private cancel?: () => void;
  private exit?: () => void;

  constructor() {
    this.ui = new TuiMainScreen(new ProcessTerminal());
    this.editor = new Editor(this.ui, EDITOR_THEME);
    this.document.addChild(new Text("helios", 0, 0));
    this.document.addChild(this.transcript);
    this.document.addChild(this.tools);
    this.document.addChild(this.status);
    this.document.addChild(this.editor);
    this.ui.addChild(this.document);
    this.ui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) return undefined;
      this.cancel?.();
      return { consume: true };
    });
    this.ui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+d")) return undefined;
      this.exit?.();
      return { consume: true };
    });
  }

  start(state: SessionViewState): void {
    this.render(state);
    this.editor.onSubmit = (text) => {
      this.editor.setText("");
      this.submit?.(text);
    };
    this.ui.start();
    this.ui.setFocus(this.editor);
  }

  update(state: SessionViewState): void {
    this.render(state);
  }

  async stop(): Promise<void> {
    this.ui.stop();
  }

  onSubmit(handler: (text: string) => void): void {
    this.submit = handler;
  }

  onCancel(handler: () => void): void {
    this.cancel = handler;
  }

  onExit(handler: () => void): void {
    this.exit = handler;
  }

  askQuestion(request: AskQuestionRequest): Promise<AskQuestionResponse> {
    return askApproval(this, request);
  }

  show(question: string, options: readonly string[], resolve: (answer: string | undefined) => void): void {
    const overlay = new Container();
    overlay.addChild(new Text(question, 1, 0));
    const choices = options.length > 0 ? options : ["Cancel"];
    const list = new SelectList(
      choices.map((label) => ({ value: label, label })),
      Math.min(choices.length, 8),
      EDITOR_THEME.selectList,
    );
    overlay.addChild(list);
    const handle = this.ui.showOverlay(overlay, { width: "70%", maxHeight: "50%" });
    list.onSelect = (item) => {
      handle.hide();
      resolve(item.value);
    };
    list.onCancel = () => {
      handle.hide();
      resolve(undefined);
    };
  }

  private render(state: SessionViewState): void {
    this.transcript.clear();
    for (const message of state.messages) {
      const thinking = message.thinking ? `\n[thinking] ${message.thinking}` : "";
      this.transcript.addChild(new Text(`${message.role} › ${message.text}${thinking}`, 0, 0));
    }
    this.tools.clear();
    for (const tool of state.tools) {
      const detail = tool.descriptor?.detail ?? summarize(tool.output);
      this.tools.addChild(new Text(`⚙ ${tool.descriptor?.label ?? tool.name}: ${tool.status}${detail ? ` — ${detail}` : ""}`, 0, 0));
    }
    this.status.setText(state.status);
    this.editor.disableSubmit = state.busy;
    this.ui.requestRender();
  }
}

function summarize(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
