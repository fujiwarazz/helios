import { renderValue } from "./sessionViewModel";

/** Output lines kept visible when collapsed. The tail is what matters — errors land at the end. */
export const TOOL_OUTPUT_TAIL_LINES = 12;

/**
 * The argument worth showing for each builtin tool. Field names mirror the schemas in
 * `packages/kernel/src/builtin/tools.ts`; anything unlisted falls back to compact JSON, which is
 * still far better than the previous behaviour of showing nothing at all.
 */
const PRIMARY_ARGUMENT: Record<string, readonly string[]> = {
  Bash: ["command"],
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  WebFetch: ["url"],
  Task: ["description"],
  // AskUserQuestion is deliberately absent: the question is already rendered in full by the prompt
  // panel below the transcript, and echoing it in the card showed the same sentence twice.
  AskUserQuestion: [],
};

/** One-line summary of what a tool was invoked with. Width is handled by the renderer. */
export function formatToolInput(name: string, input: unknown): string {
  if (input === undefined || input === null) return "";
  const fields = PRIMARY_ARGUMENT[name];
  // An explicitly empty field list means "this tool's input is not worth echoing", so it must not
  // fall through to the JSON dump below.
  if (fields?.length === 0) return "";
  if (fields && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const field of fields) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return renderValue(input);
}

/**
 * Tool output split into displayable lines, collapsed to the last `TOOL_OUTPUT_TAIL_LINES` unless
 * expanded. `hiddenCount` is how many leading lines were dropped, so the caller can say so.
 */
export function formatToolOutput(
  output: unknown,
  expanded: boolean,
): { lines: string[]; hiddenCount: number } {
  if (output === undefined || output === null) return { lines: [], hiddenCount: 0 };
  const text = renderValue(output);
  if (text === "") return { lines: [], hiddenCount: 0 };
  const all = text.replace(/\n+$/, "").split("\n");
  if (expanded || all.length <= TOOL_OUTPUT_TAIL_LINES) return { lines: all, hiddenCount: 0 };
  return {
    lines: all.slice(all.length - TOOL_OUTPUT_TAIL_LINES),
    hiddenCount: all.length - TOOL_OUTPUT_TAIL_LINES,
  };
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
