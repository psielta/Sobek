import * as vscode from "vscode";
import type { Prompt, TargetAgent } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import type { PromptTreeItem } from "../ui/tree";
import type { AgentKind } from "./agents";
import { TerminalManager } from "./manager";

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

function agentPicks(): Array<{ label: string; description: string; agent: AgentKind }> {
  return [
    {
      label: "Claude",
      description: "claude --dangerously-skip-permissions --effort max",
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
      await manager.create({ prompt, agent });
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
      await manager.create({ prompt, agent: picked.agent, submitPrompt: true });
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
      await manager.create({ agent: (agent as { agent?: AgentKind }).agent });
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
  }

  await manager.create({ prompt: child, agent, submitPrompt: true });
}
