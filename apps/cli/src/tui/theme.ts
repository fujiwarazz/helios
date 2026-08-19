import type { EditorTheme, MarkdownTheme } from "@helios/tui";

export type Style = (text: string) => string;

const sgr =
  (code: string): Style =>
  (text) =>
    `\x1b[${code}m${text}\x1b[0m`;

/**
 * Styles below use **targeted** resets rather than `0m`, because `0m` clears every attribute —
 * including the background.
 *
 * That matters wherever styled text sits inside a background-filled `Box`: the fill is applied by
 * wrapping the whole padded line (`\x1b[48;5;Nm` … `\x1b[49m`), so one `0m` in the middle kills the
 * background for the rest of the line, including the trailing padding. The visible symptom was tool
 * cards whose dark block stopped abruptly at the end of each styled line, leaving a ragged edge.
 */
const fg =
  (color: string): Style =>
  (text) =>
    `\x1b[38;5;${color}m${text}\x1b[39m`;

const bg =
  (color: string): Style =>
  (text) =>
    `\x1b[48;5;${color}m${text}\x1b[49m`;

/** Helios terminal palette: 256-colour SGR so it works on plain xterm without truecolor. */
export const palette = {
  accent: fg("111"),
  user: fg("150"),
  assistant: fg("111"),
  system: fg("180"),
  muted: fg("244"),
  success: fg("108"),
  error: fg("174"),
  /** `22m` turns bold off without touching colour or background. */
  strong: (text: string) => `\x1b[1m${text}\x1b[22m`,
  /** Question overlay fill — without it the overlay reads as text floating in the transcript. */
  overlayBg: bg("236"),
  toolCardBg: bg("235"),
  toolCardErrorBg: bg("52"),
} as const;

export const HELIOS_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => palette.strong(palette.accent(text)),
  link: palette.accent,
  linkUrl: palette.muted,
  code: sgr("38;5;223"),
  codeBlock: sgr("38;5;223"),
  codeBlockBorder: palette.muted,
  quote: palette.muted,
  quoteBorder: palette.muted,
  hr: palette.muted,
  listBullet: palette.accent,
  bold: palette.strong,
  italic: sgr("3"),
  strikethrough: sgr("9"),
  underline: sgr("4"),
};

export const HELIOS_EDITOR_THEME: EditorTheme = {
  borderColor: palette.muted,
  selectList: {
    selectedPrefix: palette.accent,
    selectedText: palette.accent,
    description: palette.muted,
    scrollInfo: palette.muted,
    noMatch: palette.muted,
  },
};
