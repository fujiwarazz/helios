import type { Terminal } from "@helios/tui";
import { TuiMainScreen } from "@helios/tui";
import { describe, expect, it } from "vitest";
import { HeliosInteractiveView } from "./heliosInteractiveView";

/**
 * Fake terminal so the tests can drive a REAL `TuiMainScreen`. That matters: the overlay bug these
 * tests guard lived inside the TUI's own focus dispatch (`focusedComponent.handleInput`), so a
 * mocked `ui` would hide it again.
 */
class FakeTerminal implements Terminal {
  onInput?: (data: string) => void;
  readonly columns = 100;
  readonly rows = 40;
  readonly kittyProtocolActive = false;

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function harness() {
  const terminal = new FakeTerminal();
  const ui = new TuiMainScreen(terminal);
  const view = new HeliosInteractiveView(ui);
  view.start({ entries: [], messages: [], tools: [], busy: false, status: "Ready" });
  const press = (data: string): void => terminal.onInput?.(data);
  return { view, press, ui };
}

describe("HeliosInteractiveView question overlay", () => {
  it("routes keystrokes to the option list, so a question can actually be answered", async () => {
    // Regression: the overlay used to be focused on its wrapper Container, which has no
    // handleInput. Every keystroke was dropped, askQuestion never resolved and the tool call hung.
    const { view, press } = harness();
    const answered = view.askQuestion({
      question: "选哪个基底？",
      options: [{ label: "main", description: "最新" }, { label: "PR#36" }],
    });

    press(DOWN);
    press(ENTER);

    await expect(answered).resolves.toEqual({ answers: ["PR#36"] });
  });

  it("cancelling resolves with no answers rather than hanging", async () => {
    const { view, press } = harness();
    const answered = view.askQuestion({
      question: "继续？",
      options: [{ label: "Allow" }],
    });

    press(ESC);

    await expect(answered).resolves.toEqual({ answers: [] });
  });

  it("lets the user type an answer when the model supplied no options", async () => {
    // AskUserQuestion's `options` is optional; an open question used to offer only "Cancel".
    const { view, press } = harness();
    const answered = view.askQuestion({ question: "随便问我个问题" });

    for (const ch of "乌龙茶") press(ch);
    press(ENTER);

    await expect(answered).resolves.toEqual({ answers: ["乌龙茶"] });
  });

  it("keeps routing keys after the overlay swaps its option list for a text input", async () => {
    // Focus must survive the swap. Moving focus to the inner component instead of the overlay root
    // looked like it worked, but the TUI pulls focus back to the overlay root, so the input went
    // dead and the run hung after the user picked 「其他」.
    const { view, press } = harness();
    const answered = view.askQuestion({
      question: "选一种饮料",
      options: [{ label: "咖啡" }, { label: "茶" }],
    });

    press(DOWN);
    press(DOWN);
    press(ENTER);
    for (const ch of "气泡水") press(ch);
    press(ENTER);

    await expect(answered).resolves.toEqual({ answers: ["气泡水"] });
  });

  it("returns focus to the editor once the overlay closes", async () => {
    const { view, press } = harness();
    const answered = view.askQuestion({ question: "继续？", options: [{ label: "Allow" }] });
    press(ENTER);
    await answered;

    // Typing must reach the prompt again, otherwise the session is unusable after one question.
    let submitted: string | undefined;
    view.onSubmit((text) => {
      submitted = text;
    });
    for (const ch of "hi") press(ch);
    press(ENTER);

    expect(submitted).toBe("hi");
  });
});
