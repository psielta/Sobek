import * as vscode from "vscode";
import type { Prompt, TargetAgent } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import type { PromptTreeItem } from "../ui/tree";
import {
  buildAgentCommand,
  EFFORT_LEVELS,
  type AgentKind,
  type EffortLevel,
  type WorktreeOption,
} from "./agents";
import { TerminalManager } from "./manager";

/**
 * Resolves the --effort flag for Claude and Grok launches (both CLIs accept
 * low/medium/high/xhigh/max). The per-agent setting can pin a value
 * ("default" omits the flag) or "ask" to prompt on every launch. Returns
 * undefined when the user cancels the picker, aborting the launch.
 */
async function resolveEffort(agent: AgentKind): Promise<{ effort?: EffortLevel } | undefined> {
  const settingKey =
    agent === "Claude" || agent === "ClaudePlan"
      ? "claudeEffort"
      : agent === "Grok"
        ? "grokEffort"
        : undefined;
  if (!settingKey) {
    return {};
  }
  const configured = vscode.workspace
    .getConfiguration("sobek.terminals")
    .get<string>(settingKey, settingKey === "claudeEffort" ? "ask" : "default");
  if (configured === "default") {
    return {};
  }
  if ((EFFORT_LEVELS as string[]).includes(configured)) {
    return { effort: configured as EffortLevel };
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: vscode.l10n.t("Agent default (no --effort)"),
        description: buildAgentCommand(agent),
        effort: undefined as EffortLevel | undefined,
      },
      ...EFFORT_LEVELS.map((effort) => ({
        label: effort,
        description: `--effort ${effort}`,
        effort: effort as EffortLevel | undefined,
      })),
    ],
    { placeHolder: vscode.l10n.t("Effort level for this terminal") }
  );
  if (!picked) {
    return undefined;
  }
  return { effort: picked.effort };
}

/**
 * Resolves Claude's `--worktree` for the launch. The sobek.terminals
 * .claudeWorktree setting can pin "off"/"on" or "ask" (default) to offer the
 * choice per launch: no worktree, auto-named worktree or a named one.
 * Returns undefined when the user cancels, aborting the launch.
 */
async function resolveWorktree(
  agent: AgentKind
): Promise<{ worktree?: WorktreeOption } | undefined> {
  if (agent !== "Claude" && agent !== "ClaudePlan") {
    return {};
  }
  const configured = vscode.workspace
    .getConfiguration("sobek.terminals")
    .get<string>("claudeWorktree", "ask");
  if (configured === "off") {
    return {};
  }
  if (configured === "on") {
    return { worktree: true };
  }

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(circle-slash) ${vscode.l10n.t("No worktree")}`,
        description: vscode.l10n.t("Runs in the current workspace checkout"),
        value: "none" as const,
      },
      {
        label: `$(git-branch) ${vscode.l10n.t("New worktree")}`,
        description: "--worktree",
        value: "auto" as const,
      },
      {
        label: `$(edit) ${vscode.l10n.t("New worktree with a name...")}`,
        description: "--worktree <name>",
        value: "named" as const,
      },
    ],
    { placeHolder: vscode.l10n.t("Isolate this session in a git worktree?") }
  );
  if (!picked) {
    return undefined;
  }
  if (picked.value === "named") {
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t("Worktree name"),
      placeHolder: vscode.l10n.t("E.g.: feature-csv-export"),
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          return vscode.l10n.t("Enter a name.");
        }
        return /^[\w./-]+$/.test(trimmed)
          ? undefined
          : vscode.l10n.t("Use only letters, numbers and . _ / -");
      },
    });
    if (name === undefined) {
      return undefined;
    }
    return { worktree: name.trim() };
  }
  return picked.value === "auto" ? { worktree: true } : {};
}

type PromptRef = string | PromptTreeItem | undefined;

function resolvePromptId(ref: PromptRef): string | undefined {
  return typeof ref === "string" ? ref : ref?.prompt.id;
}

/** Default agent for a prompt, mirroring Thoth's targetAgent mapping. */
export function agentForTarget(target: TargetAgent): AgentKind {
  switch (target) {
    case "Codex":
      return "Codex";
    case "Grok":
      return "Grok";
    default:
      return "Claude";
  }
}

type LaunchMode = "run" | "stage" | "plan" | "open";

/**
 * "Como vai ser a execução": submit now, stage as an unsent draft, Claude
 * plan mode, or just open the agent with nothing typed.
 */
async function pickLaunchMode(agent: AgentKind): Promise<LaunchMode | undefined> {
  const items: Array<{ label: string; description?: string; mode: LaunchMode }> = [
    {
      label: `$(play) ${vscode.l10n.t("Run now")}`,
      description: vscode.l10n.t("Submits the prompt to the agent immediately"),
      mode: "run",
    },
    {
      label: `$(edit) ${vscode.l10n.t("Stage as draft")}`,
      description: vscode.l10n.t("Types the prompt without Enter — review and send yourself"),
      mode: "stage",
    },
  ];
  if (agent === "Claude") {
    items.push({
      label: `$(checklist) ${vscode.l10n.t("Plan mode")}`,
      description: vscode.l10n.t("Stages the prompt as a planning draft and marks the task"),
      mode: "plan",
    });
  }
  items.push({
    label: `$(terminal) ${vscode.l10n.t("Just open the agent")}`,
    description: vscode.l10n.t("Launches the CLI with nothing typed"),
    mode: "open",
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t("How should the prompt run?"),
  });
  return picked?.mode;
}

function agentPicks(): Array<{ label: string; description: string; agent: AgentKind }> {
  return [
    {
      label: "Claude",
      description: "claude --dangerously-skip-permissions [--effort ...] [--worktree]",
      agent: "Claude",
    },
    {
      label: vscode.l10n.t("Plan with Claude"),
      description: vscode.l10n.t("Launches Claude and stages the prompt as a plan-mode draft"),
      agent: "ClaudePlan",
    },
    { label: "Codex", description: "codex --yolo", agent: "Codex" },
    { label: "Grok", description: "grok --always-approve", agent: "Grok" },
  ];
}

async function pickAgent(options?: { hidePlan?: boolean }): Promise<AgentKind | undefined> {
  const picks = options?.hidePlan
    ? agentPicks().filter((pick) => pick.agent !== "ClaudePlan")
    : agentPicks();
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: vscode.l10n.t("Agent to launch in the terminal"),
  });
  return picked?.agent;
}

export function registerTerminalCommands(
  context: vscode.ExtensionContext,
  store: PromptStore,
  manager: TerminalManager
): void {
  const requirePrompt = (ref: PromptRef): Prompt | undefined => {
    const id = resolvePromptId(ref);
    return id ? store.require(id) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.newPromptTerminal", async (ref: PromptRef) => {
      const prompt = requirePrompt(ref);
      if (!prompt) {
        return;
      }
      await manager.create({ prompt });
    }),

    vscode.commands.registerCommand("sobek.launchAgentTerminal", async (ref: PromptRef) => {
      const prompt = requirePrompt(ref);
      if (!prompt) {
        return;
      }
      // ClaudePlan only makes sense with a prompt to stage.
      const agent = await pickAgent({ hidePlan: prompt.content.trim().length === 0 });
      if (!agent) {
        return;
      }
      const effort = await resolveEffort(agent);
      if (!effort) {
        return;
      }
      const worktree = await resolveWorktree(agent);
      if (!worktree) {
        return;
      }
      await manager.create({ prompt, agent, effort: effort.effort, worktree: worktree.worktree });
    }),

    vscode.commands.registerCommand("sobek.runPromptInAgentTerminal", async (ref: PromptRef) => {
      const prompt = requirePrompt(ref);
      if (!prompt) {
        return;
      }
      if (prompt.content.trim().length === 0) {
        void vscode.window.showWarningMessage(vscode.l10n.t("The prompt is empty."));
        return;
      }
      const defaultAgent = agentForTarget(prompt.targetAgent);
      const picked = await vscode.window.showQuickPick(
        agentPicks()
          .filter((pick) => pick.agent !== "ClaudePlan")
          .map((pick) => ({
            ...pick,
            label: pick.agent === defaultAgent ? `$(star-full) ${pick.label}` : pick.label,
          })),
        { placeHolder: vscode.l10n.t("Run the prompt in which agent?") }
      );
      if (!picked) {
        return;
      }
      const mode = await pickLaunchMode(picked.agent);
      if (!mode) {
        return;
      }
      const agent: AgentKind = mode === "plan" ? "ClaudePlan" : picked.agent;
      const effort = await resolveEffort(agent);
      if (!effort) {
        return;
      }
      const worktree = await resolveWorktree(agent);
      if (!worktree) {
        return;
      }
      await manager.create({
        prompt,
        agent,
        submitPrompt: mode === "run",
        stagePrompt: mode === "stage",
        effort: effort.effort,
        worktree: worktree.worktree,
      });
    }),

    vscode.commands.registerCommand("sobek.newWorkspaceTerminal", async () => {
      const agent = await vscode.window.showQuickPick(
        [
          { label: `$(terminal) ${vscode.l10n.t("Plain shell")}`, agent: undefined },
          ...agentPicks().filter((pick) => pick.agent !== "ClaudePlan"),
        ],
        { placeHolder: vscode.l10n.t("Workspace terminal") }
      );
      if (!agent) {
        return;
      }
      const kind = (agent as { agent?: AgentKind }).agent;
      if (kind) {
        const effort = await resolveEffort(kind);
        if (!effort) {
          return;
        }
        const worktree = await resolveWorktree(kind);
        if (!worktree) {
          return;
        }
        await manager.create({ agent: kind, effort: effort.effort, worktree: worktree.worktree });
        return;
      }
      await manager.create({});
    })
  );
}

/**
 * Post-child-creation offer, like Thoth's CreateAgentTerminalDialog: run the
 * child prompt in an agent terminal now, defaulting to the child's target
 * agent but letting the user pick Claude/Codex/Grok instead.
 */
export async function offerAgentTerminalForChild(
  manager: TerminalManager,
  child: Prompt
): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("sobek")
    .get<boolean>("terminals.showAgentTerminalOfferAfterChildPrompt", true);
  if (!enabled) {
    return;
  }
  const defaultAgent = agentForTarget(child.targetAgent);
  const runDefaultLabel = vscode.l10n.t("Run in {0}", defaultAgent);
  const chooseLabel = vscode.l10n.t("Choose agent...");
  const answer = await vscode.window.showInformationMessage(
    vscode.l10n.t("Run the child prompt in an agent terminal now?"),
    runDefaultLabel,
    chooseLabel
  );
  if (!answer) {
    return;
  }

  let agent: AgentKind = defaultAgent;
  let mode: LaunchMode = "run";
  if (answer === chooseLabel) {
    const picked = await vscode.window.showQuickPick(
      agentPicks()
        .filter((pick) => pick.agent !== "ClaudePlan")
        .map((pick) => ({
          ...pick,
          label: pick.agent === defaultAgent ? `$(star-full) ${pick.label}` : pick.label,
        })),
      { placeHolder: vscode.l10n.t("Run the prompt in which agent?") }
    );
    if (!picked) {
      return;
    }
    agent = picked.agent;
    const pickedMode = await pickLaunchMode(agent);
    if (!pickedMode) {
      return;
    }
    mode = pickedMode;
  }

  const resolvedAgent: AgentKind = mode === "plan" ? "ClaudePlan" : agent;
  const effort = await resolveEffort(resolvedAgent);
  if (!effort) {
    return;
  }
  const worktree = await resolveWorktree(resolvedAgent);
  if (!worktree) {
    return;
  }
  await manager.create({
    prompt: child,
    agent: resolvedAgent,
    submitPrompt: mode === "run",
    stagePrompt: mode === "stage",
    effort: effort.effort,
    worktree: worktree.worktree,
  });
}
