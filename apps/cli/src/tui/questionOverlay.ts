import type { AskQuestionRequest } from "@helios/ports";
import { Box, type Component, type Focusable, Input, SelectList, Text } from "@helios/tui";

/**
 * The child currently reading keys. `focused` is optional because only some components track it
 * (`Input` does, to draw its cursor; `SelectList` does not), and `handleInput` is optional on
 * `Component` itself.
 */
type ActiveChild = Component & { focused?: boolean };
import { HELIOS_EDITOR_THEME, palette } from "./theme";

/** Sentinel for the synthetic "answer in my own words" choice appended after the real options. */
const FREE_TEXT_CHOICE = "\u0000free-text";
const FREE_TEXT_LABEL = "其他（自己输入）";
const MAX_VISIBLE_OPTIONS = 8;

/**
 * The AskUserQuestion overlay: a filled box holding the question plus either an option list or a
 * free-text input.
 *
 * **Why this is a Focusable root rather than a plain `Box`.** The TUI dispatches keys to
 * `focusedComponent.handleInput`. A `Box`/`Container` has no `handleInput`, so focusing one drops
 * every keystroke — that is what made the question unanswerable and hung the tool call. Focusing
 * the inner `SelectList` instead is not a fix either: the active child is swapped when the user
 * picks 「其他」, so focus has to live somewhere stable. Hence the root is focusable and forwards
 * input to whichever child is currently active.
 */
export class QuestionOverlay implements Component, Focusable {
  /** Called exactly once with the chosen/typed answers, or an empty array when cancelled. */
  onDone?: (answers: string[]) => void;

  private readonly box = new Box(1, 1, palette.overlayBg);
  private active?: ActiveChild;
  private isFocused = false;
  private done = false;

  constructor(private readonly request: AskQuestionRequest) {
    if (request.header) this.box.addChild(new Text(palette.strong(request.header), 0, 0));
    this.box.addChild(new Text(request.question, 0, 0));
    const options = request.options ?? [];
    if (options.length === 0) this.showInput();
    else this.showOptions(options);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    // Forwarded so the Input can draw its cursor.
    if (this.active) this.active.focused = value;
  }

  handleInput(data: string): void {
    this.active?.handleInput?.(data);
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }

  private showOptions(options: NonNullable<AskQuestionRequest["options"]>): void {
    const items = [
      ...options.map((option) => ({
        value: option.label,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      // A fixed list rarely covers everything, so free text stays reachable even with options.
      { value: FREE_TEXT_CHOICE, label: FREE_TEXT_LABEL },
    ];
    const list = new SelectList(
      items,
      Math.min(items.length, MAX_VISIBLE_OPTIONS),
      HELIOS_EDITOR_THEME.selectList,
    );
    list.onSelect = (item) => {
      if (item.value === FREE_TEXT_CHOICE) {
        this.box.removeChild(list);
        this.showInput();
        return;
      }
      this.finish([item.value]);
    };
    list.onCancel = () => this.finish([]);
    this.setActive(list);
  }

  private showInput(): void {
    const input = new Input();
    input.onSubmit = (value) => this.finish(value.trim() ? [value.trim()] : []);
    input.onEscape = () => this.finish([]);
    this.setActive(input);
  }

  private setActive(component: ActiveChild): void {
    this.active = component;
    component.focused = this.isFocused;
    this.box.addChild(component);
  }

  private finish(answers: string[]): void {
    if (this.done) return;
    this.done = true;
    this.onDone?.(answers);
  }
}
