import { describe, expect, it } from "vitest";
import { selectInteractiveMode } from "./interactiveMode";

describe("selectInteractiveMode", () => {
  it("uses the TUI only for an interactive terminal without a one-shot message", () => {
    expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: true, stdoutIsTTY: true })).toBe("tui");
    expect(selectInteractiveMode({ hasMessage: true, stdinIsTTY: true, stdoutIsTTY: true })).toBe("plain");
    expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: false, stdoutIsTTY: true })).toBe("plain");
    expect(selectInteractiveMode({ hasMessage: false, stdinIsTTY: true, stdoutIsTTY: false })).toBe("plain");
  });
});
