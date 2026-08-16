import type { Logger } from "@helios/ports";

export interface TuiLogger extends Logger {
  /** Routes buffered and future warnings/errors into the rendered transcript. */
  attach(sink: (line: string) => void): void;
}

/**
 * While the TUI owns the screen, stdout belongs to the rendered frame: any stray `console.*`
 * write shifts the terminal cursor and the differential renderer repaints stale lines (duplicated
 * status bar, missing editor border). Kernel logs therefore go to the transcript, never to stdout.
 */
export function createTuiLogger(): TuiLogger {
  const pending: string[] = [];
  let sink: ((line: string) => void) | undefined;
  const emit = (level: string, args: readonly unknown[]): void => {
    const line = `[${level}] ${args.map(format).join(" ")}`;
    if (sink) sink(line);
    else pending.push(line);
  };
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    attach(next) {
      sink = next;
      for (const line of pending.splice(0)) next(line);
    },
  };
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
