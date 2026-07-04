import * as vscode from "vscode";
import type { Prompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import { findPhaseByRole, setPhase } from "../core/workflow";
import {
  AGENT_COMMAND_DELAY_MS,
  AGENT_COMMANDS,
  AGENT_TAB_DEFAULTS,
  CLAUDE_PLAN_FOLLOW_UP_DELAY_MS,
  flattenPromptForCli,
  needsLeadingCharStaging,
  SLASH_STAGING_DELAY_MS,
  type AgentKind,
} from "./agents";

export const MAX_SESSIONS_PER_PROMPT = 8;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ManagedTerminal {
  terminal: vscode.Terminal;
  promptId?: string;
}

/**
 * Prompt-bound terminals on top of the native VS Code terminal API. Replaces
 * Thoth's ConPTY/SignalR stack while preserving the product semantics: agent
 * launch commands, prompt flattening, ClaudePlan draft staging and the
 * "archived prompts have no terminals" rule.
 */
export class TerminalManager {
  private readonly managed = new Set<ManagedTerminal>();

  constructor(
    private readonly store: PromptStore,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const entry of this.managed) {
          if (entry.terminal === terminal) {
            this.managed.delete(entry);
          }
        }
      })
    );
  }

  countFor(promptId: string): number {
    return [...this.managed].filter((entry) => entry.promptId === promptId).length;
  }

  /**
   * Creates a terminal in the workspace root. Child prompts share the parent's
   * working directory — in Sobek both are the open workspace.
   */
  async create(options: {
    prompt?: Prompt;
    agent?: AgentKind;
    submitPrompt?: boolean;
  }): Promise<vscode.Terminal | undefined> {
    const { prompt, agent } = options;

    if (prompt?.status === "Archived") {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Archived prompts cannot open terminals.")
      );
      return undefined;
    }
    if (prompt && this.countFor(prompt.id) >= MAX_SESSIONS_PER_PROMPT) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Limit of {0} terminals per prompt reached.", MAX_SESSIONS_PER_PROMPT)
      );
      return undefined;
    }

    const defaults = agent ? AGENT_TAB_DEFAULTS[agent] : undefined;
    const baseName = defaults?.name ?? "Terminal";
    const name = prompt ? `${baseName} · ${prompt.title || "prompt"}` : `${baseName} · Sobek`;

    const terminal = vscode.window.createTerminal({
      name: name.slice(0, 80),
      cwd: this.store.root,
      color: defaults ? new vscode.ThemeColor(defaults.themeColor) : undefined,
      iconPath: new vscode.ThemeIcon(agent ? "robot" : "terminal"),
    });
    this.managed.add({ terminal, promptId: prompt?.id });
    terminal.show();

    if (agent) {
      await delay(AGENT_COMMAND_DELAY_MS);
      terminal.sendText(AGENT_COMMANDS[agent], true);

      const content = prompt ? flattenPromptForCli(prompt.content) : "";
      if (agent === "ClaudePlan" && content) {
        // Draft only: staged into the CLI without Enter so the user reviews it.
        await delay(CLAUDE_PLAN_FOLLOW_UP_DELAY_MS);
        await this.writeStaged(terminal, content, false);
        await this.tryEnterPlanMode(prompt);
      } else if (options.submitPrompt && content) {
        await delay(CLAUDE_PLAN_FOLLOW_UP_DELAY_MS);
        await this.writeStaged(terminal, content, true);
      }
    }

    return terminal;
  }

  /**
   * Writes prompt text to the CLI. Leading `/` or `#` is staged alone first so
   * the agent's autocomplete registers the slash command / memory shortcut.
   */
  private async writeStaged(
    terminal: vscode.Terminal,
    content: string,
    submit: boolean
  ): Promise<void> {
    if (needsLeadingCharStaging(content)) {
      terminal.sendText(content[0], false);
      await delay(SLASH_STAGING_DELAY_MS);
      terminal.sendText(content.slice(1), submit);
      return;
    }
    terminal.sendText(content, submit);
  }

  /**
   * Opening ClaudePlan on a root prompt moves its workflow to the Planning
   * phase (Thoth's "Plan mode iniciado"), unless the task is already past it.
   */
  private async tryEnterPlanMode(prompt: Prompt | undefined): Promise<void> {
    if (!prompt || prompt.parentPromptId) {
      return;
    }
    const fresh = this.store.get(prompt.id);
    const workflow = fresh?.workflow;
    if (!workflow || workflow.status !== "Active") {
      return;
    }
    const planning = findPhaseByRole(workflow, "Planning");
    if (!planning) {
      return;
    }
    const current = workflow.phases.find((phase) => phase.id === workflow.currentPhaseId);
    if (current && current.orderIndex >= planning.orderIndex) {
      return;
    }
    await this.store.mutateWorkflow(prompt.id, (target, now) => {
      setPhase(target, planning.id, now, undefined, "Plan mode iniciado");
    });
  }

  /** Archived prompts must not keep terminals alive. */
  killForPrompt(promptId: string): void {
    for (const entry of [...this.managed]) {
      if (entry.promptId === promptId) {
        entry.terminal.dispose();
        this.managed.delete(entry);
      }
    }
  }
}
