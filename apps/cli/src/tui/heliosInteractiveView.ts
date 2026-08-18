import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  type SlashCommand,
  type TUI,
} from "@helios/tui";
import { askApproval, type ApprovalOverlayHost } from "./approvalOverlay";
import { QuestionOverlay } from "./questionOverlay";
import type { InteractiveView } from "./interactiveCli";
import type { SessionViewState } from "./sessionViewModel";
import { SLASH_COMMANDS } from "./slashCommands";
import { HELIOS_EDITOR_THEME, palette } from "./theme";
import { TranscriptComponent } from "./transcriptComponents";

const HINT =
  "/help 查看命令 · ctrl+t 展开思考 · ctrl+o 展开工具输出 · ctrl+c 中断 · ctrl+d 退出";
/** Pixel-block spinner: shown only while a run produced no visible output yet. */
const SPINNER_FRAMES = ["▖", "▘", "▝", "▗"];
const SPINNER_INTERVAL_MS = 120;

export class HeliosInteractiveView implements InteractiveView, ApprovalOverlayHost {
  private readonly ui: TUI;
  private readonly document = new Container();
  private readonly transcript = new TranscriptComponent();
  private readonly status = new Text("", 1, 0);
  private readonly editor: Editor;
  private loader?: Loader;
  private loaderRunning = false;
  private state?: SessionViewState;
  private submit?: (text: string) => void;
  private cancel?: () => void;
  private exit?: () => void;

  /**
   * @param ui injected only by tests, which need to drive a fake `Terminal`. The question overlay's
   *   focus handling can only be verified against a real `TUI` — a mocked `ui` is exactly what let
   *   the overlay ship keyboard-dead.
   */
  constructor(ui: TUI = new TuiMainScreen(new ProcessTerminal())) {
    this.ui = ui;
    this.editor = new Editor(this.ui, HELIOS_EDITOR_THEME);
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(slashCommandItems(), process.cwd()),
    );
    this.document.addChild(new Text(palette.accent("helios"), 1, 0));
    this.document.addChild(this.transcript);
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
    this.ui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+o")) return undefined;
      this.transcript.setToolOutputExpanded(!this.transcript.isToolOutputExpanded());
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

  show(request: AskQuestionRequest, resolve: (answers: string[]) => void): void {
    const overlay = new QuestionOverlay(request);
    // The overlay root is itself focusable, so showOverlay's own focus handling is correct here and
    // hide() restores the editor on its own. See QuestionOverlay for why that matters.
    const handle = this.ui.showOverlay(overlay, { width: "70%", maxHeight: "60%" });
    overlay.onDone = (answers) => {
      handle.hide();
      resolve(answers);
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
      if (!this.loaderRunning) return;
      this.loaderRunning = false;
      this.loader?.stop();
      this.transcript.setPending(undefined);
      return;
    }
    if (!this.loader) {
      // Deliberately not the word "thinking": that is the name of the model's reasoning block, and
      // having a spinner by the same name appear first made it look like reasoning arrived before
      // the assistant label.
      this.loader = new Loader(this.ui, palette.accent, palette.muted, "waiting for model…", {
        frames: SPINNER_FRAMES,
        intervalMs: SPINNER_INTERVAL_MS,
      });
    }
    if (this.loaderRunning) return;
    this.loaderRunning = true;
    this.loader.start();
    this.transcript.setPending(this.loader);
  }
}

/** A run has visible output once its newest message carries text or reasoning. */
function hasVisibleOutput(state: SessionViewState): boolean {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role === "user") return false;
  return last.text.length > 0 || last.thinking.length > 0;
}

/**
 * Slash commands are typed into the same editor, so they double as autocomplete entries.
 *
 * `name` must be the BARE command name, without the leading `/`. The provider strips the slash
 * before matching (it filters against `textBeforeCursor.slice(1)` and looks up argument
 * completions by `name === textBeforeCursor.slice(1, spaceIndex)`) and re-adds it when rebuilding
 * the line. Registering `/help` here yielded `//help`, which then failed to dispatch.
 */
function slashCommandItems(): SlashCommand[] {
  return Object.entries(SLASH_COMMANDS).map(([name, spec]) => ({
    name,
    description: spec.description,
    argumentHint: spec.syntax.slice(`/${name}`.length).trim() || undefined,
  }));
}
