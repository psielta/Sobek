import * as vscode from "vscode";
import type { PromptStatus, TargetAgent } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import { ChildPromptPreviewProvider } from "./child-preview";
import { promptStatusLabel, targetAgentLabel } from "./labels";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

const ALL_STATUSES: PromptStatus[] = ["Draft", "Ready", "Archived"];
const ALL_AGENTS: TargetAgent[] = ["ClaudeCode", "Codex", "Grok"];

function resolvePromptId(ref: PromptRef): string | undefined {
  if (typeof ref === "string") {
    return ref;
  }
  return ref?.prompt.id;
}

async function pickRootPrompt(store: PromptStore, placeHolder: string): Promise<string | undefined> {
  const roots = store.listRoots().filter((prompt) => prompt.status !== "Archived");
  if (roots.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("No active prompts in this workspace.")
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    roots.map((prompt) => ({
      label: prompt.title || vscode.l10n.t("(untitled)"),
      description: prompt.workflow?.currentPhaseName,
      id: prompt.id,
    })),
    { placeHolder }
  );
  return picked?.id;
}

export function registerPromptCommands(
  context: vscode.ExtensionContext,
  store: PromptStore
): void {
  const open = async (ref: PromptRef) => {
    const id = resolvePromptId(ref) ?? (await pickRootPrompt(store, vscode.l10n.t("Open prompt")));
    if (!id) {
      return;
    }
    const prompt = store.require(id);
    if (prompt.parentPromptId) {
      await openChild(id);
      return;
    }
    const document = await vscode.workspace.openTextDocument(store.promptMarkdownPath(id));
    await vscode.window.showTextDocument(document);
  };

  const openChild = async (ref: PromptRef) => {
    const id = resolvePromptId(ref);
    if (!id) {
      return;
    }
    const prompt = store.require(id);
    const uri = ChildPromptPreviewProvider.uriFor(prompt.id, prompt.title);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, "markdown");
    await vscode.window.showTextDocument(document, { preview: true });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.createPrompt", async () => {
      const title = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Title for the new prompt"),
        placeHolder: vscode.l10n.t("E.g.: Implement CSV export"),
        validateInput: (value) =>
          value.trim().length === 0 ? vscode.l10n.t("Enter a title.") : undefined,
      });
      if (!title) {
        return;
      }
      const prompt = await store.create({ title: title.trim(), content: "" });
      await open(prompt.id);
    }),

    vscode.commands.registerCommand("sobek.openPrompt", open),
    vscode.commands.registerCommand("sobek.openChildPrompt", openChild),

    vscode.commands.registerCommand("sobek.copyPromptContent", async (ref: PromptRef) => {
      const id =
        resolvePromptId(ref) ??
        (await pickRootPrompt(store, vscode.l10n.t("Copy content of which prompt?")));
      if (!id) {
        return;
      }
      await vscode.env.clipboard.writeText(store.require(id).content);
      void vscode.window.showInformationMessage(vscode.l10n.t("Prompt content copied."));
    }),

    vscode.commands.registerCommand("sobek.renamePrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const title = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("New title"),
        value: prompt.title,
        validateInput: (value) =>
          value.trim().length === 0 ? vscode.l10n.t("Enter a title.") : undefined,
      });
      if (!title || title.trim() === prompt.title) {
        return;
      }
      await store.update(id, { title: title.trim() });
    }),

    vscode.commands.registerCommand("sobek.setPromptStatus", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const picked = await vscode.window.showQuickPick(
        ALL_STATUSES.map((status) => ({
          label:
            status === prompt.status
              ? `$(check) ${promptStatusLabel(status)}`
              : promptStatusLabel(status),
          status,
        })),
        { placeHolder: vscode.l10n.t("Prompt status") }
      );
      if (!picked || picked.status === prompt.status) {
        return;
      }
      await store.updateStatus(id, picked.status);
    }),

    vscode.commands.registerCommand("sobek.setTargetAgent", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const picked = await vscode.window.showQuickPick(
        ALL_AGENTS.map((agent) => ({
          label:
            agent === prompt.targetAgent
              ? `$(check) ${targetAgentLabel(agent)}`
              : targetAgentLabel(agent),
          agent,
        })),
        { placeHolder: vscode.l10n.t("Target agent for the prompt") }
      );
      if (!picked || picked.agent === prompt.targetAgent) {
        return;
      }
      await store.update(id, { targetAgent: picked.agent });
    }),

    vscode.commands.registerCommand("sobek.archivePrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      await store.updateStatus(id, "Archived");
      void vscode.window.showInformationMessage(vscode.l10n.t("Prompt archived."));
    }),

    vscode.commands.registerCommand("sobek.deletePrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const children = store.listChildren(id).length;
      const message =
        children > 0
          ? vscode.l10n.t(
              'Delete prompt "{0}" and its {1} child prompt(s)? This cannot be undone.',
              prompt.title,
              children
            )
          : vscode.l10n.t('Delete prompt "{0}"? This cannot be undone.', prompt.title);
      const confirmLabel = vscode.l10n.t("Delete");
      const confirmation = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel
      );
      if (confirmation !== confirmLabel) {
        return;
      }
      await store.delete(id);
    }),

    vscode.commands.registerCommand("sobek.showPromptVersions", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const versions = await store.getVersions(id);
      const picked = await vscode.window.showQuickPick(
        [...versions].reverse().map((version) => ({
          label: `v${version.versionNumber} — ${version.changeNote}`,
          description: new Date(version.createdAt).toLocaleString(),
          detail: version.title,
          version,
        })),
        { placeHolder: vscode.l10n.t("Prompt version history") }
      );
      if (!picked) {
        return;
      }
      const document = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: picked.version.content,
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  // Editing prompt.md in the native editor is the update path: saving syncs
  // content into the store, snapshotting a new version ("Updated").
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const prompt = store.findByMarkdownPath(document.uri.fsPath);
      if (prompt && document.getText() !== prompt.content) {
        await store.update(prompt.id, { content: document.getText() });
      }
    })
  );
}
