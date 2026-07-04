import * as vscode from "vscode";
import * as fs from "node:fs";
import { defaultClaudeCredentialsPath, fetchClaudeUsage } from "../usage/claude-usage";
import { defaultCodexSessionsDir, fetchCodexUsage } from "../usage/codex-usage";
import type { AgentUsage, UsageWindow } from "../usage/types";

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // sleep after 60 minutes without activity
const WARNING_THRESHOLD = 70;
const ERROR_THRESHOLD = 90;
/** Anthropic usage API cooldown — Thoth polls it at most once per minute. */
const CLAUDE_MIN_INTERVAL_MS = 60 * 1000;
const CLAUDE_FORCED_MIN_INTERVAL_MS = 15 * 1000;

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
  private lastClaude: AgentUsage | undefined;
  private lastCodex: AgentUsage | undefined;
  private lastClaudeFetchAt = 0;

  constructor(context: vscode.ExtensionContext) {
    this.claudeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.codexItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.claudeItem.command = "sobek.showAgentUsage";
    this.codexItem.command = "sobek.showAgentUsage";
    context.subscriptions.push(
      this.claudeItem,
      this.codexItem,
      vscode.commands.registerCommand("sobek.refreshAgentUsage", () => {
        this.recordActivity();
        void this.refresh({ force: true });
      }),
      vscode.commands.registerCommand("sobek.showAgentUsage", () => {
        this.recordActivity();
        void this.showPanel();
      }),
      new vscode.Disposable(() => this.stopPolling())
    );

    this.setLoading(this.claudeItem, "Claude");
    this.setLoading(this.codexItem, "Codex");
    this.claudeItem.show();
    this.codexItem.show();

    // Initial reading shortly after activation, without slowing it down.
    setTimeout(() => void this.refresh(), 2000);
    this.watchCodexSessions(context);
  }

  /**
   * Like Thoth's FileSystemWatcher on the Codex sessions dir: new JSONL
   * activity refreshes the indicator with a 500ms debounce. Best-effort —
   * recursive fs.watch is unavailable on some platforms.
   */
  private watchCodexSessions(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration("sobek.usage");
    const dir = config.get<string>("codexSessionsPath", "") || defaultCodexSessionsDir();
    let debounce: NodeJS.Timeout | undefined;
    try {
      const watcher = fs.watch(dir, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          // Codex activity only refreshes the Codex indicator; hitting the
          // Anthropic API on every JSONL append would trip its rate limit.
          this.wake();
          void this.refresh({ target: "codex" });
        }, 500);
      });
      context.subscriptions.push(
        new vscode.Disposable(() => {
          clearTimeout(debounce);
          watcher.close();
        })
      );
    } catch {
      // Directory missing or recursive watch unsupported — polling covers it.
    }
  }

  /** Starts the poll timer without triggering an immediate fetch. */
  private wake(): void {
    this.lastActivity = Date.now();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollTick(), POLL_INTERVAL_MS);
    }
  }

  /** Wakes the poller; call whenever an agent terminal/AI action happens. */
  recordActivity(): void {
    const wasSleeping = !this.pollTimer;
    this.wake();
    if (wasSleeping) {
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

  async refresh(options: { force?: boolean; target?: "claude" | "codex" | "both" } = {}): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const target = options.target ?? "both";
      const config = vscode.workspace.getConfiguration("sobek.usage");
      const claudePath = config.get<string>("claudeCredentialsPath", "");
      const codexDir = config.get<string>("codexSessionsPath", "");

      const errorUsage = (error: unknown): AgentUsage => ({
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 0, resetsAt: null },
        limitsAvailable: false,
        lastUpdated: Date.now(),
        error: (error as Error).message,
      });

      const tasks: Array<Promise<void>> = [];

      if (target !== "codex") {
        // Cooldown so watcher bursts and click spam never trip Anthropic's
        // rate limit (a 429 here previously stuck the indicator on "--").
        const minInterval = options.force
          ? CLAUDE_FORCED_MIN_INTERVAL_MS
          : CLAUDE_MIN_INTERVAL_MS;
        if (Date.now() - this.lastClaudeFetchAt >= minInterval) {
          this.lastClaudeFetchAt = Date.now();
          tasks.push(
            fetchClaudeUsage({ credentialsPath: claudePath || defaultClaudeCredentialsPath() })
              .catch(errorUsage)
              .then((claude) => {
                // On 429, keep showing the last good reading instead of "--".
                if (claude.error === "rate-limited" && this.lastClaude?.limitsAvailable) {
                  return;
                }
                this.lastClaude = claude;
              })
          );
        }
      }

      if (target !== "claude") {
        tasks.push(
          fetchCodexUsage({ sessionsDir: codexDir || defaultCodexSessionsDir() })
            .catch(errorUsage)
            .then((codex) => {
              this.lastCodex = codex;
            })
        );
      }

      await Promise.all(tasks);
      if (this.lastClaude) {
        this.render(this.claudeItem, "Claude", this.lastClaude);
      }
      if (this.lastCodex) {
        this.render(this.codexItem, "Codex", this.lastCodex);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /** Click widget: usage breakdown for both agents plus quick actions. */
  private async showPanel(): Promise<void> {
    if (!this.lastClaude && !this.lastCodex) {
      await this.refresh();
    }

    type Item = vscode.QuickPickItem & { action?: "refresh" | "settings" };
    const items: Item[] = [];

    const section = (label: string, usage: AgentUsage | undefined): void => {
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      if (!usage) {
        items.push({ label: `$(sync~spin) ${vscode.l10n.t("Reading {0} usage...", label)}` });
        return;
      }
      if (!usage.limitsAvailable) {
        items.push({
          label: `$(warning) ${errorLabel(usage.error ?? "no-data")}`,
        });
        if (usage.tokenUsage) {
          items.push({
            label: `$(symbol-number) ${vscode.l10n.t(
              "Session tokens: {0}",
              usage.tokenUsage.totalTokens.toLocaleString()
            )}`,
          });
        }
        return;
      }
      const windowItem = (icon: string, name: string, window: UsageWindow): Item => {
        const reset = formatReset(window.resetsAt);
        return {
          label: `$(${icon}) ${name}: ${Math.round(window.utilization)}%`,
          description: reset ? vscode.l10n.t("resets {0}", reset) : undefined,
        };
      };
      items.push(windowItem("dashboard", vscode.l10n.t("5-hour window"), usage.fiveHour));
      items.push(windowItem("calendar", vscode.l10n.t("7-day window"), usage.sevenDay));
      if (usage.sevenDayOpus) {
        items.push(
          windowItem("sparkle", vscode.l10n.t("7-day window (Opus)"), usage.sevenDayOpus)
        );
      }
      if (usage.tokenUsage) {
        items.push({
          label: `$(symbol-number) ${vscode.l10n.t(
            "Session tokens: {0}",
            usage.tokenUsage.totalTokens.toLocaleString()
          )}`,
        });
      }
    };

    section("Claude Code", this.lastClaude);
    section("Codex", this.lastCodex);

    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(refresh) ${vscode.l10n.t("Refresh now")}`, action: "refresh" });
    items.push({ label: `$(gear) ${vscode.l10n.t("Usage settings")}`, action: "settings" });

    const updatedAt = this.lastClaude?.lastUpdated ?? this.lastCodex?.lastUpdated;
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Agent usage limits"),
      placeHolder: updatedAt
        ? vscode.l10n.t(
            "Updated {0} — click to refresh",
            new Date(updatedAt).toLocaleTimeString(vscode.env.language)
          )
        : undefined,
    });
    if (picked?.action === "refresh") {
      await this.refresh();
      void this.showPanel();
    } else if (picked?.action === "settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "sobek.usage");
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

      // Thoth colors by the primary (displayed) window, not the worst one.
      item.backgroundColor =
        fiveHour >= ERROR_THRESHOLD
          ? new vscode.ThemeColor("statusBarItem.errorBackground")
          : fiveHour >= WARNING_THRESHOLD
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
