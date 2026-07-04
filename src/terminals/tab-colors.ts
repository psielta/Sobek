/**
 * Terminal tab palette from `frontend/src/features/prompts/terminal-tab-preferences.ts`,
 * mapped to the VS Code terminal theme colors the native API accepts.
 */

export interface TerminalTabColor {
  id: string;
  label: string;
  hex: string | null;
  themeColor: string | null;
}

export const TERMINAL_TAB_COLORS: TerminalTabColor[] = [
  { id: "default", label: "Padrão", hex: null, themeColor: null },
  { id: "crimson", label: "Vermelho", hex: "#e74856", themeColor: "terminal.ansiRed" },
  { id: "orange", label: "Laranja", hex: "#ff8c00", themeColor: "terminal.ansiYellow" },
  { id: "gold", label: "Dourado", hex: "#c19c00", themeColor: "terminal.ansiBrightYellow" },
  { id: "green", label: "Verde", hex: "#16c60c", themeColor: "terminal.ansiGreen" },
  { id: "teal", label: "Azul-petróleo", hex: "#3a96dd", themeColor: "terminal.ansiCyan" },
  { id: "blue", label: "Azul", hex: "#0078d4", themeColor: "terminal.ansiBlue" },
  { id: "purple", label: "Roxo", hex: "#8761b9", themeColor: "terminal.ansiMagenta" },
  { id: "pink", label: "Rosa", hex: "#ff99a4", themeColor: "terminal.ansiBrightRed" },
  { id: "grey", label: "Cinza", hex: "#767676", themeColor: "terminal.ansiBrightBlack" },
];

export const MAX_TAB_NAME_LENGTH = 32;
