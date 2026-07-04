import * as vscode from "vscode";
import type { Prompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import {
  advancePhase,
  completeWorkflow,
  editPhases,
  reopenWorkflow,
  setPhase,
} from "../core/workflow";
import { buildWebviewHtml } from "../lib/webview-html";
import { workflowActorLabel } from "./labels";

export interface BoardCard {
  id: string;
  title: string;
  status: string;
  workflowStatus?: string;
  phaseName?: string;
  phaseColor?: string;
  actorLabel?: string;
  iteration: number;
  reviewVerdictSource?: string;
  hasChildren: boolean;
  hasLinkedPlan: boolean;
  updatedAt: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  color?: string;
  droppable: boolean;
  cards: BoardCard[];
}

const NO_WORKFLOW_COLUMN = "__none__";
const DONE_COLUMN = "__done__";

function toCard(prompt: Prompt): BoardCard {
  const workflow = prompt.workflow;
  return {
    id: prompt.id,
    title: prompt.title || vscode.l10n.t("(untitled)"),
    status: prompt.status,
    workflowStatus: workflow?.status,
    phaseName: workflow?.currentPhaseName,
    phaseColor: workflow?.currentPhaseColor,
    actorLabel: workflow?.currentActor ? workflowActorLabel(workflow.currentActor) : undefined,
    iteration: workflow?.currentPhaseIteration ?? 1,
    reviewVerdictSource: workflow?.reviewVerdictSourcePhaseName,
    hasChildren: false,
    hasLinkedPlan: !!prompt.linkedPlan,
    updatedAt: prompt.updatedAt,
  };
}

/**
 * Board columns mirror Thoth's buildColumns: "Sem fluxo" first (not a drop
 * target), one column per phase of the global template, extra columns for
 * active phases outside the template, then "Concluídas".
 */
export function buildBoardColumns(store: PromptStore): BoardColumn[] {
  const roots = store.listRoots();
  const cards = roots.map((prompt) => ({ prompt, card: toCard(prompt) }));
  for (const entry of cards) {
    entry.card.hasChildren = store.listChildren(entry.prompt.id).length > 0;
  }

  const columns: BoardColumn[] = [];
  const noWorkflow = cards.filter((entry) => !entry.prompt.workflow);
  if (noWorkflow.length > 0) {
    columns.push({
      id: NO_WORKFLOW_COLUMN,
      title: vscode.l10n.t("No workflow"),
      droppable: false,
      cards: noWorkflow.map((entry) => entry.card),
    });
  }

  const active = cards.filter((entry) => entry.prompt.workflow?.status === "Active");
  const template = [...store.getSettings().phaseTemplate].sort(
    (a, b) => a.orderIndex - b.orderIndex
  );
  const templateNames = new Set(template.map((phase) => phase.name));

  for (const phase of template) {
    columns.push({
      id: `phase:${phase.name}`,
      title: phase.name,
      color: phase.color,
      droppable: true,
      cards: active
        .filter((entry) => entry.prompt.workflow?.currentPhaseName === phase.name)
        .map((entry) => entry.card),
    });
  }

  const customNames = [
    ...new Set(
      active
        .map((entry) => entry.prompt.workflow?.currentPhaseName)
        .filter((name): name is string => !!name && !templateNames.has(name))
    ),
  ];
  for (const name of customNames) {
    columns.push({
      id: `phase:${name}`,
      title: name,
      droppable: true,
      cards: active
        .filter((entry) => entry.prompt.workflow?.currentPhaseName === name)
        .map((entry) => entry.card),
    });
  }

  columns.push({
    id: DONE_COLUMN,
    title: vscode.l10n.t("Done"),
    droppable: true,
    cards: cards
      .filter((entry) => entry.prompt.workflow?.status === "Done")
      .map((entry) => entry.card),
  });

  return columns;
}

/** Kanban board panel; a single instance is reused across invocations. */
export class BoardPanel {
  private static current: BoardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, store: PromptStore): void {
    if (BoardPanel.current) {
      BoardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "sobekBoard",
      "Sobek: Board",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    BoardPanel.current = new BoardPanel(panel, context, store);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly store: PromptStore
  ) {
    // Webview tab icons are not theme-masked like activity bar icons, so the
    // panel needs explicit light/dark variants.
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "sobek-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "sobek-dark.svg"),
    };
    panel.webview.html = buildWebviewHtml({
      webview: panel.webview,
      extensionUri: context.extensionUri,
      entry: "board",
      title: "Sobek: Board",
      initialState: { columns: buildBoardColumns(store), language: vscode.env.language },
    });

    this.disposables.push(
      new vscode.Disposable(this.store.onDidChange(() => this.postState())),
      panel.webview.onDidReceiveMessage((message) => void this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose())
    );
  }

  private postState(): void {
    void this.panel.webview.postMessage({
      type: "state",
      columns: buildBoardColumns(this.store),
    });
  }

  private async handleMessage(message: {
    type: string;
    promptId?: string;
    columnId?: string;
    note?: string;
  }): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          this.postState();
          break;
        case "openPrompt":
          await vscode.commands.executeCommand("sobek.openPrompt", message.promptId);
          break;
        case "generateChild":
          await vscode.commands.executeCommand("sobek.generateChildPrompt", message.promptId);
          break;
        case "archive":
          await this.store.updateStatus(message.promptId!, "Archived");
          break;
        case "advance":
          await this.store.mutateWorkflow(message.promptId!, (workflow, now) =>
            advancePhase(workflow, now)
          );
          break;
        case "addNote":
          await vscode.commands.executeCommand("sobek.addWorkflowNote", message.promptId);
          break;
        case "moveTask":
          await this.moveTask(message.promptId!, message.columnId!);
          break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage((error as Error).message);
    }
  }

  /**
   * Drag semantics from Thoth's board: dropping on "Concluídas" completes;
   * dropping on a phase starts/reopens/moves the workflow, adding the phase
   * to the task snapshot when the template gained it later.
   */
  private async moveTask(promptId: string, columnId: string): Promise<void> {
    const prompt = this.store.require(promptId);

    if (columnId === DONE_COLUMN) {
      if (prompt.workflow?.status === "Active") {
        await this.store.mutateWorkflow(promptId, (workflow, now) =>
          completeWorkflow(workflow, now)
        );
      }
      return;
    }
    if (!columnId.startsWith("phase:")) {
      return;
    }
    const phaseName = columnId.slice("phase:".length);

    if (!prompt.workflow) {
      const template = [...this.store.getSettings().phaseTemplate].sort(
        (a, b) => a.orderIndex - b.orderIndex
      );
      const index = template.findIndex((phase) => phase.name === phaseName);
      await this.store.startWorkflowFor(promptId, index >= 0 ? index : 0);
      return;
    }

    await this.store.mutateWorkflow(promptId, (workflow, now) => {
      if (workflow.status === "Done") {
        reopenWorkflow(workflow, now);
      }
      let target = workflow.phases.find((phase) => phase.name === phaseName);
      if (!target) {
        const templatePhase = this.store
          .getSettings()
          .phaseTemplate.find((phase) => phase.name === phaseName);
        if (!templatePhase) {
          throw new Error(vscode.l10n.t('Phase "{0}" does not exist in this task.', phaseName));
        }
        editPhases(
          workflow,
          [
            ...workflow.phases.map((phase) => ({
              id: phase.id,
              name: phase.name,
              defaultActor: phase.defaultActor,
              orderIndex: phase.orderIndex,
              color: phase.color,
            })),
            {
              name: templatePhase.name,
              defaultActor: templatePhase.defaultActor,
              orderIndex: workflow.phases.length,
              color: templatePhase.color,
            },
          ],
          now
        );
        target = workflow.phases.find((phase) => phase.name === phaseName);
      }
      if (target) {
        setPhase(workflow, target.id, now);
      }
    });
  }

  private dispose(): void {
    BoardPanel.current = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
