/**
 * Agent launch semantics ported from Thoth
 * (`backend/src/Thoth.Application/Features/Terminals/TerminalAgentLaunch.cs`).
 */

export type AgentKind = "Claude" | "ClaudePlan" | "Codex" | "Grok";

const CLAUDE_BASE_FLAGS = "--dangerously-skip-permissions --effort max";

export const AGENT_COMMANDS: Record<AgentKind, string> = {
  Claude: `claude ${CLAUDE_BASE_FLAGS}`,
  ClaudePlan: `claude ${CLAUDE_BASE_FLAGS}`,
  Codex: "codex --yolo",
  Grok: "grok --always-approve",
};

export interface AgentTabDefaults {
  name: string;
  color: string;
  /** Closest VS Code terminal theme color for the tab icon. */
  themeColor: string;
}

/** Tab defaults from `frontend/src/features/prompts/terminal-tab-preferences.ts`. */
export const AGENT_TAB_DEFAULTS: Record<AgentKind, AgentTabDefaults> = {
  Claude: { name: "Claude", color: "#8761b9", themeColor: "terminal.ansiMagenta" },
  ClaudePlan: { name: "Claude Plan", color: "#5b4b8a", themeColor: "terminal.ansiBrightMagenta" },
  Codex: { name: "Codex", color: "#16c60c", themeColor: "terminal.ansiGreen" },
  Grok: { name: "Grok", color: "#ff8c00", themeColor: "terminal.ansiYellow" },
};

/** Delay before the agent command is written to a fresh shell (ms). */
export const AGENT_COMMAND_DELAY_MS = 500;

/** Extra delay before the ClaudePlan draft is staged after the command (ms). */
export const CLAUDE_PLAN_FOLLOW_UP_DELAY_MS = 2000;

/** Gap after the leading '/' or '#' so CLI autocomplete registers it (ms). */
export const SLASH_STAGING_DELAY_MS = 25;

/**
 * Flattens a Markdown prompt into a single CLI line: in agent CLIs, Enter
 * submits, so a multi-line prompt would be sent prematurely.
 * Mirrors `TerminalAgentLaunch.FlattenPromptForClaudeCli`.
 */
export function flattenPromptForCli(content: string): string {
  return content.replace(/\r\n|\r|\n/g, " ").trim();
}

/** True when the prompt starts with a slash command or memory shortcut. */
export function needsLeadingCharStaging(flattened: string): boolean {
  return flattened.startsWith("/") || flattened.startsWith("#");
}
