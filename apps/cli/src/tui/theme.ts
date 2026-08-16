import type { EditorTheme, MarkdownTheme } from "@helios/tui";

export type Style = (text: string) => string;

const sgr =
  (code: string): Style =>
  (text) =>
    `\x1b[${code}m${text}\x1b[0m`;

/** Helios terminal palette: 256-colour SGR so it works on plain xterm without truecolor. */
export const palette = {
  accent: sgr("38;5;111"),
  user: sgr("38;5;150"),
  assistant: sgr("38;5;111"),
  system: sgr("38;5;180"),
  muted: sgr("38;5;244"),
  success: sgr("38;5;108"),
  error: sgr("38;5;174"),
  strong: sgr("1"),
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
