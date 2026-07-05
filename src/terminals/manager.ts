import * as vscode from "vscode";
import type { Prompt } from "../core/prompt";
import { newId } from "../lib/ids";
import type { PromptStore } from "../store/prompt-store";
import { findPhaseByRole, setPhase } from "../core/workflow";
import {
  AGENT_TAB_DEFAULTS,
  buildAgentCommand,
  buildAgentRunCommand,
  flattenPromptForCli,
  needsLeadingCharStaging,
  SLASH_STAGING_DELAY_MS,
  type AgentKind,
  type EffortLevel,
  type ShellFlavor,
} from "./agents";

export const MAX_SESSIONS_PER_PROMPT = 8;

const SHELL_READY_TIMEOUT_MS = 3000;
const STAGE_CHUNK_SIZE = 180;
const STAGE_CHUNK_DELAY_MS = 15;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where the terminal opens: the panel (Ctrl+`) or an editor tab. The
 * sobek.terminals.location setting pins a choice; "ask" (default) prompts on
 * every creation. Returns undefined when the user cancels the picker.
 */
async function resolveTerminalLocation(): Promise<vscode.TerminalLocation | undefined> {
  const configured = vscode.workspace
    .getConfiguration("sobek.terminals")
    .get<string>("location", "ask");
  if (configured === "panel") {
    return vscode.TerminalLocation.Panel;
  }
  if (configured === "editor") {
    return vscode.TerminalLocation.Editor;
  }
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(layout-panel) ${vscode.l10n.t("Terminal panel")}`,
        description: "Ctrl+`",
        location: vscode.TerminalLocation.Panel,
      },
      {
        label: `$(window) ${vscode.l10n.t("Editor tab")}`,
        description: vscode.l10n.t("Opens the terminal as an editor tab"),
        location: vscode.TerminalLocation.Editor,
      },
    ],
    { placeHolder: vscode.l10n.t("Where should the terminal open?") }
  );
  return picked?.location;
}

function detectShellFlavor(): ShellFlavor {
  const shell = vscode.env.shell.toLowerCase();
  if (shell.includes("pwsh") || shell.includes("powershell")) {
    return "powershell";
  }
  return process.platform === "win32" ? "powershell" : "posix";
}

/**
 * Waits until the terminal's shell reports ready via shell integration (or a
 * timeout fallback). Blind fixed delays raced slow shell startups and cut off
 * whatever was typed next.
 */
function waitForShellReady(terminal: vscode.Terminal): Promise<void> {
  if (terminal.shellIntegration) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve();
    }, SHELL_READY_TIMEOUT_MS);
    const listener = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      }
    });
  });
}

export interface ManagedTerminal {
  /** Stable identifier, safe to hand to webviews (Terminal has no id). */
  id: string;
  terminal: vscode.Terminal;
  promptId?: string;
  agent?: AgentKind;
  createdAt: number;
}

/**
 * Prompt-bound terminals on top of the native VS Code terminal API. Replaces
 * Thoth's ConPTY/SignalR stack while preserving the product semantics: agent
 * launch commands, prompt flattening, ClaudePlan draft staging and the
 * "archived prompts have no terminals" rule.
 */
export class TerminalManager {
  private readonly managed = new Set<ManagedTerminal>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires when a Sobek terminal is created or closed. */
  readonly onDidChange = this.changeEmitter.event;

  /** Notified when an agent CLI is launched (feeds the usage indicators). */
  onAgentLaunch?: () => void;

  constructor(
    private readonly store: PromptStore,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(
      this.changeEmitter,
      vscode.window.onDidCloseTerminal((terminal) => {
        let removed = false;
        for (const entry of this.managed) {
          if (entry.terminal === terminal) {
            this.managed.delete(entry);
            removed = true;
          }
        }
        if (removed) {
          this.changeEmitter.fire();
        }
      })
    );
  }

  list(): ManagedTerminal[] {
    return [...this.managed].sort((a, b) => a.createdAt - b.createdAt);
  }

  findById(id: string): ManagedTerminal | undefined {
    return [...this.managed].find((entry) => entry.id === id);
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
    /** Submit the flattened prompt to the CLI (Enter included). */
    submitPrompt?: boolean;
    /** Stage the flattened prompt as an unsent draft (no Enter). */
    stagePrompt?: boolean;
    /** --effort level for Claude/Grok launches (omitted = CLI default). */
    effort?: EffortLevel;
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

    const location = await resolveTerminalLocation();
    if (location === undefined) {
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
      location,
    });
    this.managed.add({ id: newId(), terminal, promptId: prompt?.id, agent, createdAt: Date.now() });
    this.changeEmitter.fire();
    terminal.show();

    if (agent) {
      this.onAgentLaunch?.();
      await waitForShellReady(terminal);
      const content = prompt?.content.trim() ? prompt.content : "";
      const shell = detectShellFlavor();

      if (agent === "ClaudePlan" && content) {
        // Plan mode with the prompt as a CLI argument: nothing to type into a
        // booting TUI, so the prompt can never be cut off.
        terminal.sendText(buildAgentRunCommand("ClaudePlan", content, shell, options.effort), true);
        await this.tryEnterPlanMode(prompt);
      } else if (options.submitPrompt && content) {
        terminal.sendText(buildAgentRunCommand(agent, content, shell, options.effort), true);
      } else {
        terminal.sendText(buildAgentCommand(agent, options.effort), true);
        if (options.stagePrompt && content) {
          const stageDelay = vscode.workspace
            .getConfiguration("sobek.terminals")
            .get<number>("stageDelayMs", 3000);
          await delay(Math.max(500, stageDelay));
          await this.writeStaged(terminal, flattenPromptForCli(content));
        }
      }
    }

    return terminal;
  }

  /**
   * Stages prompt text into a running CLI without Enter. Leading `/` or `#`
   * goes alone first (so autocomplete registers it) and the rest streams in
   * small chunks — long single writes raced the TUI's input handling and
   * arrived truncated.
   */
  private async writeStaged(terminal: vscode.Terminal, content: string): Promise<void> {
    let rest = content;
    if (needsLeadingCharStaging(content)) {
      terminal.sendText(content[0], false);
      await delay(SLASH_STAGING_DELAY_MS);
      rest = content.slice(1);
    }
    for (let offset = 0; offset < rest.length; offset += STAGE_CHUNK_SIZE) {
      terminal.sendText(rest.slice(offset, offset + STAGE_CHUNK_SIZE), false);
      if (offset + STAGE_CHUNK_SIZE < rest.length) {
        await delay(STAGE_CHUNK_DELAY_MS);
      }
    }
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
      setPhase(target, planning.id, now, undefined, vscode.l10n.t("Plan mode started"));
    });
  }

  /** Archived prompts must not keep terminals alive. */
  killForPrompt(promptId: string): void {
    let removed = false;
    for (const entry of [...this.managed]) {
      if (entry.promptId === promptId) {
        entry.terminal.dispose();
        this.managed.delete(entry);
        removed = true;
      }
    }
    if (removed) {
      this.changeEmitter.fire();
    }
  }
}
