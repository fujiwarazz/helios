import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatToolInput,
  formatToolOutput,
  TOOL_OUTPUT_TAIL_LINES,
} from "./toolCardFormat";

describe("formatToolInput", () => {
  it("picks the argument that identifies the call, per tool", () => {
    expect(formatToolInput("Bash", { command: "git log --oneline -5", timeout: 5000 })).toBe(
      "git log --oneline -5",
    );
    expect(formatToolInput("Read", { file_path: "/repo/session.ts", offset: 10 })).toBe(
      "/repo/session.ts",
    );
    expect(formatToolInput("Grep", { pattern: "TODO", glob: "*.ts" })).toBe("TODO");
    expect(formatToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("falls back to compact JSON for tools it does not know", () => {
    expect(formatToolInput("plugin__custom", { a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  it("falls back when the expected field is missing or empty", () => {
    expect(formatToolInput("Bash", { cwd: "/tmp" })).toBe('{"cwd":"/tmp"}');
    expect(formatToolInput("Bash", { command: "" })).toBe('{"command":""}');
  });

  it("renders nothing when there is no input at all", () => {
    expect(formatToolInput("Bash", undefined)).toBe("");
    expect(formatToolInput("Bash", null)).toBe("");
  });
});

describe("formatToolOutput", () => {
  const output = (count: number): string =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps the tail and reports how many leading lines it hid", () => {
    const total = TOOL_OUTPUT_TAIL_LINES + 6;
    const { lines, hiddenCount } = formatToolOutput(output(total), false);
    expect(lines).toHaveLength(TOOL_OUTPUT_TAIL_LINES);
    expect(hiddenCount).toBe(6);
    // The tail is what matters: failures and final results land at the end.
    expect(lines[lines.length - 1]).toBe(`line ${total}`);
  });

  it("hides nothing when the output already fits", () => {
    const { lines, hiddenCount } = formatToolOutput(output(TOOL_OUTPUT_TAIL_LINES), false);
    expect(lines).toHaveLength(TOOL_OUTPUT_TAIL_LINES);
    expect(hiddenCount).toBe(0);
  });

  it("returns everything when expanded", () => {
    const total = TOOL_OUTPUT_TAIL_LINES + 6;
    const { lines, hiddenCount } = formatToolOutput(output(total), true);
    expect(lines).toHaveLength(total);
    expect(hiddenCount).toBe(0);
    expect(lines[0]).toBe("line 1");
  });

  it("stringifies non-string output", () => {
    expect(formatToolOutput({ ok: true }, false).lines).toEqual(['{"ok":true}']);
  });

  it("treats absent or empty output as nothing to show", () => {
    expect(formatToolOutput(undefined, false)).toEqual({ lines: [], hiddenCount: 0 });
    expect(formatToolOutput("", false)).toEqual({ lines: [], hiddenCount: 0 });
  });

  it("ignores a trailing newline instead of counting it as a blank line", () => {
    expect(formatToolOutput("only line\n", false).lines).toEqual(["only line"]);
  });
});

describe("formatElapsed", () => {
  it("switches from milliseconds to seconds at one second", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(999)).toBe("999ms");
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(1240)).toBe("1.2s");
  });
});
