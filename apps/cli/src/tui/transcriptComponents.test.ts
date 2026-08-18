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

  it("shows what a tool was called with and what it printed, reusing the same card", () => {
    // This used to assert the opposite (input and output deliberately hidden), which left the card
    // as a bare tool name and made it impossible to see what the agent actually did.
    const transcript = new TranscriptComponent();
    transcript.update(
      state(
        [],
        [
          {
            toolUseId: "t1",
            name: "Bash",
            input: { command: "git log --oneline -2" },
            status: "running",
            startedAt: 1_000,
          },
        ],
      ),
    );
    const card = transcript.toolComponent("t1");
    const running = plain(transcript.render(80));
    expect(running).toContain("Bash");
    expect(running).toContain("git log --oneline -2");

    transcript.update(
      state(
        [],
        [
          {
            toolUseId: "t1",
            name: "Bash",
            input: { command: "git log --oneline -2" },
            output: "deb0e38 merge\n592327d fix",
            status: "success",
            startedAt: 1_000,
            endedAt: 1_240,
          },
        ],
      ),
    );
    const done = plain(transcript.render(80));
    expect(transcript.toolComponent("t1")).toBe(card);
    expect(done).toContain("deb0e38 merge");
    expect(done).toContain("Took 240ms");
  });

  it("collapses long tool output to its tail until ctrl+o expands it", () => {
    const transcript = new TranscriptComponent();
    const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const tool = {
      toolUseId: "t1",
      name: "Bash",
      input: { command: "seq 20" },
      output,
      status: "success" as const,
      startedAt: 0,
      endedAt: 100,
    };

    transcript.update(state([], [tool]));
    const collapsed = plain(transcript.render(80));
    expect(collapsed).toContain("line 20");
    expect(collapsed).not.toContain("line 1\n");
    expect(collapsed).toContain("8 earlier lines, ctrl+o to expand");

    transcript.setToolOutputExpanded(true);
    transcript.update(state([], [tool]));
    const expanded = plain(transcript.render(80));
    expect(expanded).toContain("line 1");
    expect(expanded).not.toContain("earlier lines");
  });

  it("still shows the output of a failed tool", () => {
    const transcript = new TranscriptComponent();
    transcript.update(
      state(
        [],
        [
          {
            toolUseId: "t1",
            name: "Bash",
            input: { command: "false" },
            output: "exit status 1",
            isError: true,
            status: "error",
            startedAt: 0,
            endedAt: 5,
          },
        ],
      ),
    );

    const text = plain(transcript.render(80));
    expect(text).toContain("exit status 1");
    expect(text).toContain("Took 5ms");
  });

  it("shows the pending indicator under the assistant label, at the transcript tail", () => {
    // The label must be present from the start of the run: the spinner used to live outside the
    // transcript, so `helios ›` only appeared once the first delta landed and looked like it lagged.
    const transcript = new TranscriptComponent();
    transcript.update(state([{ id: "u1", role: "user", text: "hi", thinking: "", complete: true }]));
    transcript.setPending({ render: () => ["◐ waiting for model…"], invalidate: () => {} });

    const lines = plain(transcript.render(60));
    expect(lines).toContain("helios ›");
    expect(lines).toContain("waiting for model…");
    expect(lines.indexOf("helios ›")).toBeGreaterThan(lines.indexOf("hi"));
    expect(lines.indexOf("helios ›")).toBeLessThan(lines.indexOf("waiting for model…"));

    transcript.setPending(undefined);
    expect(plain(transcript.render(60))).not.toContain("waiting for model…");
  });

  it("hides an assistant message that never produced text or reasoning", () => {
    // A run that dies before any output (e.g. a 429) used to leave a bare `helios ›` label with
    // nothing under it, while the actual error showed up as a separate system line.
    const transcript = new TranscriptComponent();
    transcript.update(
      state([
        { id: "a1", role: "assistant", text: "", thinking: "", complete: true },
        { id: "s1", role: "system", text: "[error] 429 Rate limit exceeded", thinking: "", complete: true },
      ]),
    );

    const lines = plain(transcript.render(60));
    expect(lines).not.toContain("helios ›");
    expect(lines).toContain("429 Rate limit exceeded");
  });

  it("shows the assistant label as soon as reasoning arrives, before any answer text", () => {
    const transcript = new TranscriptComponent();
    transcript.update(
      state([{ id: "a1", role: "assistant", text: "", thinking: "weighing options", complete: false }]),
    );
    expect(plain(transcript.render(60))).toContain("helios ›");
  });

  it("drops components for messages removed by /clear or a branch switch", () => {
    const transcript = new TranscriptComponent();
    transcript.update(state([{ id: "a1", role: "assistant", text: "old", thinking: "", complete: true }]));
    transcript.update(state([]));
    expect(transcript.messageComponent("a1")).toBeUndefined();
    expect(plain(transcript.render(60))).not.toContain("old");
  });
});
