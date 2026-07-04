import * as vscode from "vscode";
import {
  PROMPT_STATUS_LABELS,
  TARGET_AGENT_LABELS,
  type PromptStatus,
  type TargetAgent,
} from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import { ChildPromptPreviewProvider } from "./child-preview";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

function resolvePromptId(ref: PromptRef): string | undefined {
  if (typeof ref === "string") {
    return ref;
  }
  return ref?.prompt.id;
}

async function pickRootPrompt(store: PromptStore, placeHolder: string): Promise<string | undefined> {
  const roots = store.listRoots().filter((prompt) => prompt.status !== "Archived");
  if (roots.length === 0) {
    void vscode.window.showInformationMessage("Nenhum prompt ativo no workspace.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    roots.map((prompt) => ({
      label: prompt.title || "(sem título)",
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
    const id = resolvePromptId(ref) ?? (await pickRootPrompt(store, "Abrir prompt"));
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
        prompt: "Título do novo prompt",
        placeHolder: "Ex.: Implementar exportação CSV",
        validateInput: (value) => (value.trim().length === 0 ? "Informe um título." : undefined),
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
      const id = resolvePromptId(ref) ?? (await pickRootPrompt(store, "Copiar conteúdo de qual prompt?"));
      if (!id) {
        return;
      }
      await vscode.env.clipboard.writeText(store.require(id).content);
      void vscode.window.showInformationMessage("Conteúdo do prompt copiado.");
    }),

    vscode.commands.registerCommand("sobek.renamePrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const title = await vscode.window.showInputBox({
        prompt: "Novo título",
        value: prompt.title,
        validateInput: (value) => (value.trim().length === 0 ? "Informe um título." : undefined),
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
        (Object.entries(PROMPT_STATUS_LABELS) as [PromptStatus, string][]).map(
          ([status, label]) => ({
            label: status === prompt.status ? `$(check) ${label}` : label,
            status,
          })
        ),
        { placeHolder: "Status do prompt" }
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
        (Object.entries(TARGET_AGENT_LABELS) as [TargetAgent, string][]).map(([agent, label]) => ({
          label: agent === prompt.targetAgent ? `$(check) ${label}` : label,
          agent,
        })),
        { placeHolder: "Agente alvo do prompt" }
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
      void vscode.window.showInformationMessage("Prompt arquivado.");
    }),

    vscode.commands.registerCommand("sobek.deletePrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const prompt = store.require(id);
      const children = store.listChildren(id).length;
      const detail = children > 0 ? ` e seus ${children} prompt(s) filho(s)` : "";
      const confirmation = await vscode.window.showWarningMessage(
        `Excluir o prompt "${prompt.title}"${detail}? Essa ação não pode ser desfeita.`,
        { modal: true },
        "Excluir"
      );
      if (confirmation !== "Excluir") {
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
        { placeHolder: "Histórico de versões do prompt" }
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
