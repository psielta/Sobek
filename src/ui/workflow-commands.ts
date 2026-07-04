import * as vscode from "vscode";
import {
  addNote,
  addReviewVerdict,
  changeActor,
  completeWorkflow,
  reopenWorkflow,
  type WorkflowActor,
} from "../core/workflow";
import type { PromptStore } from "../store/prompt-store";
import { workflowActorLabel, workflowEventLabel } from "./labels";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

const ALL_ACTORS: WorkflowActor[] = ["Human", "ClaudeCode", "Codex", "Grok"];

function resolvePromptId(ref: PromptRef): string | undefined {
  return typeof ref === "string" ? ref : ref?.prompt.id;
}

export function registerWorkflowCommands(
  context: vscode.ExtensionContext,
  store: PromptStore
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.startWorkflow", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      await store.startWorkflowFor(id);
    }),

    vscode.commands.registerCommand("sobek.addWorkflowNote", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const note = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Note for the task timeline"),
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0 ? vscode.l10n.t("Enter the note.") : undefined,
      });
      if (!note) {
        return;
      }
      await store.mutateWorkflow(id, (workflow, now) => addNote(workflow, note.trim(), now));
    }),

    vscode.commands.registerCommand("sobek.addReviewVerdict", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const verdict = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Review verdict (the task moves to the correction phase)"),
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0 ? vscode.l10n.t("Enter the verdict.") : undefined,
      });
      if (!verdict) {
        return;
      }
      await store.mutateWorkflow(id, (workflow, now) =>
        addReviewVerdict(workflow, verdict.trim(), now)
      );
    }),

    vscode.commands.registerCommand("sobek.changeWorkflowActor", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const picked = await vscode.window.showQuickPick(
        ALL_ACTORS.map((actor) => ({ label: workflowActorLabel(actor), actor })),
        { placeHolder: vscode.l10n.t("Current task owner") }
      );
      if (!picked) {
        return;
      }
      await store.mutateWorkflow(id, (workflow, now) => changeActor(workflow, picked.actor, now));
    }),

    vscode.commands.registerCommand("sobek.completeWorkflow", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      await store.mutateWorkflow(id, (workflow, now) => completeWorkflow(workflow, now));
    }),

    vscode.commands.registerCommand("sobek.reopenWorkflow", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      await store.mutateWorkflow(id, (workflow, now) => reopenWorkflow(workflow, now));
    }),

    vscode.commands.registerCommand("sobek.showTimeline", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const events = prompt.workflow?.events ?? [];
      if (events.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("This task has no timeline yet.")
        );
        return;
      }
      const lines = events.map((event) => {
        const when = new Date(event.occurredAt).toLocaleString();
        const phase = event.phaseName ? ` · ${event.phaseName}` : "";
        const actor = event.actor ? ` · ${workflowActorLabel(event.actor)}` : "";
        const note = event.note ? `\n  ${event.note}` : "";
        return `- **${workflowEventLabel(event.type)}** (${when})${phase}${actor}${note}`;
      });
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Timeline — ${prompt.title}\n\n${lines.join("\n")}\n`,
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );
}
