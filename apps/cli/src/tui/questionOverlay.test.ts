import type { AskQuestionRequest } from "@helios/ports";
import { describe, expect, it } from "vitest";
import { QuestionOverlay } from "./questionOverlay";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function overlay(request: AskQuestionRequest) {
  const view = new QuestionOverlay(request);
  view.focused = true;
  const answers: string[][] = [];
  view.onDone = (a) => answers.push(a);
  const type = (text: string) => {
    for (const ch of text) view.handleInput(ch);
  };
  const frame = () => stripAnsi(view.render(80).join("\n"));
  return { view, answers, type, frame };
}

describe("QuestionOverlay", () => {
  it("renders the header, the question, and each option's description", () => {
    const { frame } = overlay({
      question: "选哪个基底？",
      header: "分支",
      options: [{ label: "main", description: "最新的 main" }],
    });

    const text = frame();
    expect(text).toContain("分支");
    expect(text).toContain("选哪个基底？");
    // Descriptions used to be dropped before they ever reached the list.
    expect(text).toContain("最新的 main");
  });

  it("resolves the selected option label", () => {
    const { answers, view } = overlay({
      question: "继续？",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });

    view.handleInput(DOWN);
    view.handleInput(ENTER);

    expect(answers).toEqual([["Deny"]]);
  });

  it("takes typed text when the model supplied no options", () => {
    // AskUserQuestion's `options` is optional; an open question used to offer only "Cancel",
    // leaving the user no way to answer at all.
    const { answers, type, view, frame } = overlay({ question: "随便问我个问题" });

    expect(frame()).not.toContain("Cancel");
    type("乌龙茶");
    view.handleInput(ENTER);

    expect(answers).toEqual([["乌龙茶"]]);
  });

  it("keeps a free-text escape hatch alongside the options", () => {
    const { answers, type, view, frame } = overlay({
      question: "选一种饮料",
      options: [{ label: "咖啡" }, { label: "茶" }],
    });
    expect(frame()).toContain("其他（自己输入）");

    view.handleInput(DOWN);
    view.handleInput(DOWN);
    view.handleInput(ENTER);
    // The list is replaced by the input, so the options are gone from the frame.
    expect(frame()).not.toContain("咖啡");
    type("气泡水");
    view.handleInput(ENTER);

    expect(answers).toEqual([["气泡水"]]);
  });

  it("resolves no answers when cancelled from either mode", () => {
    const list = overlay({ question: "继续？", options: [{ label: "Allow" }] });
    list.view.handleInput(ESC);
    expect(list.answers).toEqual([[]]);

    const free = overlay({ question: "说点什么" });
    free.view.handleInput(ESC);
    expect(free.answers).toEqual([[]]);
  });

  it("treats whitespace-only text as no answer rather than a blank one", () => {
    const { answers, type, view } = overlay({ question: "说点什么" });
    type("   ");
    view.handleInput(ENTER);
    expect(answers).toEqual([[]]);
  });

  it("reports the answer only once", () => {
    const { answers, view } = overlay({ question: "继续？", options: [{ label: "Allow" }] });
    view.handleInput(ENTER);
    view.handleInput(ENTER);
    expect(answers).toEqual([["Allow"]]);
  });
});
