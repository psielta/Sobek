/** Shared shapes for agent usage indicators (Claude Code and Codex). */

export interface UsageWindow {
  /** 0-100 percentage of the window already used. */
  utilization: number;
  /** ISO timestamp when the window resets, when known. */
  resetsAt: string | null;
}

export interface AgentUsage {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /** Claude only: dedicated Opus weekly window, when reported. */
  sevenDayOpus?: UsageWindow;
  /** Codex only: token totals fallback when rate limits are unavailable. */
  tokenUsage?: { totalTokens: number; lastTokens: number | null };
  /** False when the source had no active rate-limit data. */
  limitsAvailable: boolean;
  lastUpdated: number;
  error?: string;
}
