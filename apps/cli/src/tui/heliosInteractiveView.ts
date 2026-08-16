import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TuiMainScreen,
  type SlashCommand,
  type TUI,
} from "@helios/tui";
import { askApproval, type ApprovalOverlayHost } from "./approvalOverlay";
import type { InteractiveView } from "./interactiveCli";
import type { SessionViewState } from "./sessionViewModel";
import { SLASH_COMMANDS } from "./slashCommands";
import { HELIOS_EDITOR_THEME, palette } from "./theme";
import { TranscriptComponent } from "./transcriptComponents";

const HINT = "/help 查看命令 · ctrl+t 展开思考 · ctrl+c 中断 · ctrl+d 退出";
/** Pixel-block spinner: shown only while a run produced no visible output yet. */
const SPINNER_FRAMES = ["▖", "▘", "▝", "▗"];
const SPINNER_INTERVAL_MS = 120;

export class HeliosInteractiveView implements InteractiveView, ApprovalOverlayHost {
  private readonly ui: TUI;
  private readonly document = new Container();
  private readonly transcript = new TranscriptComponent();
  private readonly loaderSlot = new Container();
  private readonly status = new Text("", 1, 0);
  private readonly editor: Editor;
  private loader?: Loader;
  private state?: SessionViewState;
  private submit?: (text: string) => void;
  private cancel?: () => void;
  private exit?: () => void;

  constructor() {
    this.ui = new TuiMainScreen(new ProcessTerminal());
    this.editor = new Editor(this.ui, HELIOS_EDITOR_THEME);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommandItems(), process.cwd()),
    );
    this.document.addChild(new Text(palette.accent("helios"), 1, 0));
    this.document.addChild(this.transcript);
    this.document.addChild(this.loaderSlot);
    this.document.addChild(new Spacer(1));
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
    this.ui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+t")) return undefined;
      this.transcript.setThinkingExpanded(!this.transcript.isThinkingExpanded());
      if (this.state) this.render(this.state);
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
    this.setLoading(false);
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

  show(
    question: string,
    options: readonly string[],
    resolve: (answer: string | undefined) => void,
  ): void {
    const overlay = new Container();
    overlay.addChild(new Text(question, 1, 0));
    const choices = options.length > 0 ? options : ["Cancel"];
    const list = new SelectList(
      choices.map((label) => ({ value: label, label })),
      Math.min(choices.length, 8),
      HELIOS_EDITOR_THEME.selectList,
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
    this.state = state;
    this.transcript.update(state);
    this.setLoading(state.busy && !hasVisibleOutput(state));
    const label = state.busy ? palette.accent(state.status) : palette.muted(state.status);
    this.status.setText(`${label}  ${palette.muted(HINT)}`);
    this.ui.requestRender();
  }

  /** The spinner owns a timer, so it is stopped as soon as output appears or the view closes. */
  private setLoading(active: boolean): void {
    if (!active) {
      this.loader?.stop();
      this.loaderSlot.clear();
      return;
    }
    if (!this.loader) {
      this.loader = new Loader(this.ui, palette.accent, palette.muted, "thinking…", {
        frames: SPINNER_FRAMES,
        intervalMs: SPINNER_INTERVAL_MS,
      });
    }
    if (this.loaderSlot.children.length > 0) return;
    this.loader.start();
    this.loaderSlot.addChild(this.loader);
  }
}

/** A run has visible output once its newest message carries text or reasoning. */
function hasVisibleOutput(state: SessionViewState): boolean {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role === "user") return false;
  return last.text.length > 0 || last.thinking.length > 0;
}

/** Slash commands are typed into the same editor, so they double as autocomplete entries. */
function slashCommandItems(): SlashCommand[] {
  return Object.entries(SLASH_COMMANDS).map(([name, spec]) => ({
    name: `/${name}`,
    description: spec.description,
    argumentHint: spec.syntax.slice(`/${name}`.length).trim() || undefined,
  }));
}
