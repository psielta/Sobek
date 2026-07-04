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

const AGENT_PICKS: Array<{ label: string; description: string; agent: AgentKind }> = [
  {
    label: "Claude",
    description: "claude --dangerously-skip-permissions --effort max",
    agent: "Claude",
  },
  {
    label: "Planejar no Claude",
    description: "Inicia o Claude e preenche o prompt como rascunho de plan mode",
    agent: "ClaudePlan",
  },
  { label: "Codex", description: "codex --yolo", agent: "Codex" },
  { label: "Grok", description: "grok --always-approve", agent: "Grok" },
];

async function pickAgent(options?: { hidePlan?: boolean }): Promise<AgentKind | undefined> {
  const picks = options?.hidePlan
    ? AGENT_PICKS.filter((pick) => pick.agent !== "ClaudePlan")
    : AGENT_PICKS;
  const picked = await vscode.window.showQuickPick(picks, {
    placeHolder: "Agente para iniciar no terminal",
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
        void vscode.window.showWarningMessage("O prompt está vazio.");
        return;
      }
      const defaultAgent = agentForTarget(prompt.targetAgent);
      const picked = await vscode.window.showQuickPick(
        AGENT_PICKS.filter((pick) => pick.agent !== "ClaudePlan").map((pick) => ({
          ...pick,
          label: pick.agent === defaultAgent ? `$(star-full) ${pick.label}` : pick.label,
        })),
        { placeHolder: "Executar o prompt em qual agente?" }
      );
      if (!picked) {
        return;
      }
      await manager.create({ prompt, agent: picked.agent, submitPrompt: true });
    }),

    vscode.commands.registerCommand("sobek.newWorkspaceTerminal", async () => {
      const agent = await vscode.window.showQuickPick(
        [
          { label: "$(terminal) Shell simples", agent: undefined },
          ...AGENT_PICKS.filter((pick) => pick.agent !== "ClaudePlan"),
        ],
        { placeHolder: "Terminal no workspace" }
      );
      if (!agent) {
        return;
      }
      await manager.create({ agent: (agent as { agent?: AgentKind }).agent });
    })
  );
}

/**
 * Post-child-creation offer: open a terminal with the target agent already
 * executing the child prompt (Thoth's showAgentTerminalOfferAfterChildPrompt).
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
  const agent = agentForTarget(child.targetAgent);
  const answer = await vscode.window.showInformationMessage(
    `Abrir terminal com ${agent} executando o prompt filho agora?`,
    "Executar agora"
  );
  if (answer !== "Executar agora") {
    return;
  }
  await manager.create({ prompt: child, agent, submitPrompt: true });
}
