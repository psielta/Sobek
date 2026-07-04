import * as vscode from "vscode";
import { defaultClaudeCredentialsPath, fetchClaudeUsage } from "../usage/claude-usage";
import { defaultCodexSessionsDir, fetchCodexUsage } from "../usage/codex-usage";
import type { AgentUsage, UsageWindow } from "../usage/types";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // sleep after 60 minutes without activity
const WARNING_THRESHOLD = 70;
const ERROR_THRESHOLD = 90;

function formatReset(resetsAt: string | null): string | undefined {
  if (!resetsAt) {
    return undefined;
  }
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleString(vscode.env.language, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function windowLine(label: string, window: UsageWindow): string {
  const reset = formatReset(window.resetsAt);
  const resetSuffix = reset ? ` — ${vscode.l10n.t("resets {0}", reset)}` : "";
  return `- ${label}: **${Math.round(window.utilization)}%**${resetSuffix}`;
}

function errorLabel(error: string): string {
  switch (error) {
    case "no-credentials":
      return vscode.l10n.t("Log in to Claude Code to see usage.");
    case "auth-expired":
      return vscode.l10n.t("Claude session expired — log in again.");
    case "forbidden":
      return vscode.l10n.t("No usage API permission (403).");
    case "rate-limited":
      return vscode.l10n.t("Rate limited — will retry later.");
    case "no-data":
      return vscode.l10n.t("No Codex usage data found. Use the Codex CLI with a ChatGPT subscription.");
    default:
      return vscode.l10n.t("Usage error: {0}", error);
  }
}

/**
 * Status bar indicators for Claude Code and Codex usage limits, like Thoth's
 * header badges. Activity-aware polling: refreshes while agents are being
 * used, sleeps after an hour of inactivity.
 */
export class UsageStatusBar {
  private readonly claudeItem: vscode.StatusBarItem;
  private readonly codexItem: vscode.StatusBarItem;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastActivity = 0;
  private refreshing = false;

  constructor(context: vscode.ExtensionContext) {
    this.claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.codexItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.claudeItem.command = "sobek.refreshAgentUsage";
    this.codexItem.command = "sobek.refreshAgentUsage";
    context.subscriptions.push(
      this.claudeItem,
      this.codexItem,
      vscode.commands.registerCommand("sobek.refreshAgentUsage", () => {
        this.recordActivity();
        void this.refresh();
      }),
      new vscode.Disposable(() => this.stopPolling())
    );

    this.setLoading(this.claudeItem, "Claude");
    this.setLoading(this.codexItem, "Codex");
    this.claudeItem.show();
    this.codexItem.show();

    // Initial reading shortly after activation, without slowing it down.
    setTimeout(() => void this.refresh(), 2000);
  }

  /** Wakes the poller; call whenever an agent terminal/AI action happens. */
  recordActivity(): void {
    this.lastActivity = Date.now();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollTick(), POLL_INTERVAL_MS);
      void this.refresh();
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollTick(): Promise<void> {
    if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
      this.stopPolling();
      return;
    }
    await this.refresh();
  }

  private setLoading(item: vscode.StatusBarItem, label: string): void {
    item.text = `$(sync~spin) ${label}`;
    item.tooltip = vscode.l10n.t("Reading {0} usage...", label);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const config = vscode.workspace.getConfiguration("sobek.usage");
      const claudePath = config.get<string>("claudeCredentialsPath", "");
      const codexDir = config.get<string>("codexSessionsPath", "");

      const [claude, codex] = await Promise.all([
        fetchClaudeUsage({
          credentialsPath: claudePath || defaultClaudeCredentialsPath(),
        }).catch(
          (error): AgentUsage => ({
            fiveHour: { utilization: 0, resetsAt: null },
            sevenDay: { utilization: 0, resetsAt: null },
            limitsAvailable: false,
            lastUpdated: Date.now(),
            error: (error as Error).message,
          })
        ),
        fetchCodexUsage({ sessionsDir: codexDir || defaultCodexSessionsDir() }).catch(
          (error): AgentUsage => ({
            fiveHour: { utilization: 0, resetsAt: null },
            sevenDay: { utilization: 0, resetsAt: null },
            limitsAvailable: false,
            lastUpdated: Date.now(),
            error: (error as Error).message,
          })
        ),
      ]);

      this.render(this.claudeItem, "Claude", claude);
      this.render(this.codexItem, "Codex", codex);
    } finally {
      this.refreshing = false;
    }
  }

  private render(item: vscode.StatusBarItem, label: string, usage: AgentUsage): void {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${vscode.l10n.t("{0} usage limits", label)}**\n\n`);

    if (!usage.limitsAvailable) {
      item.text = `${label} --`;
      item.backgroundColor = undefined;
      if (usage.tokenUsage) {
        tooltip.appendMarkdown(
          `${vscode.l10n.t(
            "Rate limits unavailable; total tokens: {0}",
            usage.tokenUsage.totalTokens.toLocaleString()
          )}\n\n`
        );
      }
      if (usage.error) {
        tooltip.appendMarkdown(`${errorLabel(usage.error)}\n\n`);
      }
    } else {
      const fiveHour = Math.round(usage.fiveHour.utilization);
      const sevenDay = Math.round(usage.sevenDay.utilization);
      item.text = `${label} ${fiveHour}%`;
      tooltip.appendMarkdown(`${windowLine(vscode.l10n.t("5-hour window"), usage.fiveHour)}\n`);
      tooltip.appendMarkdown(`${windowLine(vscode.l10n.t("7-day window"), usage.sevenDay)}\n`);
      if (usage.sevenDayOpus) {
        tooltip.appendMarkdown(
          `${windowLine(vscode.l10n.t("7-day window (Opus)"), usage.sevenDayOpus)}\n`
        );
      }
      if (usage.tokenUsage) {
        tooltip.appendMarkdown(
          `\n${vscode.l10n.t("Session tokens: {0}", usage.tokenUsage.totalTokens.toLocaleString())}\n`
        );
      }
      tooltip.appendMarkdown("\n");

      const worst = Math.max(fiveHour, sevenDay);
      item.backgroundColor =
        worst >= ERROR_THRESHOLD
          ? new vscode.ThemeColor("statusBarItem.errorBackground")
          : worst >= WARNING_THRESHOLD
            ? new vscode.ThemeColor("statusBarItem.warningBackground")
            : undefined;
    }

    tooltip.appendMarkdown(
      vscode.l10n.t(
        "Updated {0} — click to refresh",
        new Date(usage.lastUpdated).toLocaleTimeString(vscode.env.language)
      )
    );
    item.tooltip = tooltip;
  }
}
