/**
 * Agent launch semantics ported from Thoth
 * (`backend/src/Thoth.Application/Features/Terminals/TerminalAgentLaunch.cs`).
 */

export type AgentKind = "Claude" | "ClaudePlan" | "Codex" | "Grok";

/** Effort levels shared by the Claude and Grok CLIs (`--effort`). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const CLAUDE_BASE_COMMAND = "claude --dangerously-skip-permissions";
const GROK_BASE_COMMAND = "grok --always-approve";

/**
 * CLI invocation per agent, verified against the installed CLIs: Claude and
 * Grok accept `--effort low|medium|high|xhigh|max` (omitted = CLI default);
 * Codex keeps `--yolo` (still accepted as an alias of
 * --dangerously-bypass-approvals-and-sandbox).
 */
export function buildAgentCommand(agent: AgentKind, effort?: EffortLevel): string {
  switch (agent) {
    case "Codex":
      return "codex --yolo";
    case "Grok":
      return effort ? `${GROK_BASE_COMMAND} --effort ${effort}` : GROK_BASE_COMMAND;
    default:
      return effort ? `${CLAUDE_BASE_COMMAND} --effort ${effort}` : CLAUDE_BASE_COMMAND;
  }
}

export type ShellFlavor = "powershell" | "posix";

/** Quotes a single CLI argument for the target shell. */
export function quoteForShell(text: string, shell: ShellFlavor): string {
  if (shell === "powershell") {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Full launch command with the prompt as a CLI ARGUMENT — all three CLIs
 * accept a positional prompt (`claude [prompt]`, `codex [PROMPT]`,
 * `grok [PROMPT]`). This is the reliable path for "run now" and plan mode:
 * typing into a booting TUI raced its readiness and truncated prompts, while
 * an argument can never be cut off. Plan mode uses
 * `claude --permission-mode plan` (without --dangerously-skip-permissions —
 * plan mode reviews before executing).
 */
export function buildAgentRunCommand(
  agent: AgentKind,
  prompt: string,
  shell: ShellFlavor,
  effort?: EffortLevel
): string {
  const quoted = quoteForShell(flattenPromptForCli(prompt), shell);
  switch (agent) {
    case "Codex":
      return `codex --yolo ${quoted}`;
    case "Grok":
      return `${buildAgentCommand("Grok", effort)} ${quoted}`;
    case "ClaudePlan": {
      const effortFlag = effort ? ` --effort ${effort}` : "";
      return `claude${effortFlag} --permission-mode plan ${quoted}`;
    }
    default:
      return `${buildAgentCommand("Claude", effort)} ${quoted}`;
  }
}

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
