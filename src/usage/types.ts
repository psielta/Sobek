/** Shared shapes for agent usage indicators (Claude Code and Codex). */

export interface UsageWindow {
  /** 0-100 percentage of the window already used. */
  utilization: number;
  /** ISO timestamp when the window resets, when known. */
  resetsAt: string | null;
}

/** Extra limit windows (e.g. Claude's per-model weekly caps like Fable). */
export interface ScopedUsageWindow extends UsageWindow {
  /** Display name of the scope, e.g. "Fable" or "Opus". */
  label: string;
  /** Limit group from the API ("weekly", "session", ...). */
  group?: string;
  /** True when the API flags this window as critical. */
  critical?: boolean;
}

export interface AgentUsage {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /** Claude only: additional scoped windows parsed from the limits array. */
  extraWindows?: ScopedUsageWindow[];
  /** Codex only: token totals fallback when rate limits are unavailable. */
  tokenUsage?: { totalTokens: number; lastTokens: number | null };
  /** False when the source had no active rate-limit data. */
  limitsAvailable: boolean;
  lastUpdated: number;
  error?: string;
}
