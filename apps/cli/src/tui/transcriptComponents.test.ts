import { describe, expect, it } from "vitest";
import type { SessionViewState } from "./sessionViewModel";
import { TranscriptComponent } from "./transcriptComponents";

const state = (
  messages: SessionViewState["messages"],
  tools: SessionViewState["tools"] = [],
): Pick<SessionViewState, "messages" | "tools"> => ({ messages, tools });

const plain = (lines: readonly string[]): string =>
  lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("TranscriptComponent", () => {
  it("retains the same message component across streamed deltas", () => {
    const transcript = new TranscriptComponent();
    transcript.update(
      state([{ id: "a1", role: "assistant", text: "Hel", thinking: "", complete: false }]),
    );
    const first = transcript.messageComponent("a1");

    transcript.update(
      state([{ id: "a1", role: "assistant", text: "Hello world", thinking: "", complete: true }]),
    );

    expect(transcript.messageComponent("a1")).toBe(first);
    expect(plain(transcript.render(60))).toContain("Hello world");
  });

  it("renders Markdown structure rather than one raw line", () => {
    const transcript = new TranscriptComponent();
    transcript.update(
      state([
        {
          id: "a1",
          role: "assistant",
          text: "# Title\n\n```ts\nconst x = 1;\n```",
          thinking: "",
          complete: true,
        },
      ]),
    );

    const rendered = transcript.render(60);
    const text = plain(rendered);
    expect(text).toContain("Title");
    expect(text).toContain("const x = 1;");
    // Heading, fenced code, and the role header cannot collapse onto a single line.
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered.some((line) => line.includes("\x1b["))).toBe(true);
  });

  it("collapses thinking by default and expands it on demand", () => {
    const transcript = new TranscriptComponent();
    const thinking = "step one is long ".repeat(12);
    transcript.update(state([{ id: "a1", role: "assistant", text: "answer", thinking, complete: false }]));
    const collapsed = transcript.render(60);
    expect(plain(collapsed)).toContain("thinking ·");
    expect(plain(collapsed)).not.toContain(thinking.trim());

    transcript.setThinkingExpanded(true);
    transcript.update(state([{ id: "a1", role: "assistant", text: "answer", thinking, complete: false }]));
    const expanded = transcript.render(60);
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(plain(expanded)).toContain("step one is long");
  });

  it("keeps tool cards compact and reuses them across state changes", () => {
    const transcript = new TranscriptComponent();
    transcript.update(
      state([], [{ toolUseId: "t1", name: "read", input: { path: "/secret.txt" }, status: "running" }]),
    );
    const card = transcript.toolComponent("t1");
    const running = plain(transcript.render(60));
    expect(running).toContain("read");
    expect(running).not.toContain("/secret.txt");

    transcript.update(
      state(
        [],
        [
          {
            toolUseId: "t1",
            name: "read",
            input: { path: "/secret.txt" },
            output: "file body that must stay hidden",
            status: "success",
            descriptor: { label: "Read", status: "success", detail: "12 lines" },
          },
        ],
      ),
    );
    const done = plain(transcript.render(60));
    expect(transcript.toolComponent("t1")).toBe(card);
    expect(done).toContain("Read");
    expect(done).toContain("12 lines");
    expect(done).not.toContain("file body that must stay hidden");
  });

  it("drops components for messages removed by /clear or a branch switch", () => {
    const transcript = new TranscriptComponent();
    transcript.update(state([{ id: "a1", role: "assistant", text: "old", thinking: "", complete: true }]));
    transcript.update(state([]));
    expect(transcript.messageComponent("a1")).toBeUndefined();
    expect(plain(transcript.render(60))).not.toContain("old");
  });
});
