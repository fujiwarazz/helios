export function selectInteractiveMode(options: {
  hasMessage: boolean;
  stdinIsTTY: boolean | undefined;
  stdoutIsTTY: boolean | undefined;
}): "tui" | "plain" {
  return !options.hasMessage && options.stdinIsTTY === true && options.stdoutIsTTY === true
    ? "tui"
    : "plain";
}
