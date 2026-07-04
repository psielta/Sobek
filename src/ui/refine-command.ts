import * as vscode from "vscode";
import type { AiService } from "../ai/service";
import type { PromptStore } from "../store/prompt-store";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

const PREVIEW_SCHEME = "sobek-refine";

class RefinePreviewProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(key: string, content: string): vscode.Uri {
    this.contents.set(key, content);
    const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/${key}.md`);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path.replace(/^\//, "").replace(/\.md$/, "");
    return this.contents.get(key) ?? "";
  }
}

/**
 * "Refinar" from Thoth: sends the prompt content to Gemini, previews the
 * optimized prompt in a diff against the current content and only applies it
 * when the user confirms.
 */
export function registerRefineCommand(
  context: vscode.ExtensionContext,
  store: PromptStore,
  ai: AiService
): void {
  const previews = new RefinePreviewProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),

    vscode.commands.registerCommand("sobek.refinePrompt", async (ref: PromptRef) => {
      let promptId = typeof ref === "string" ? ref : ref?.prompt.id;
      if (!promptId) {
        const active = vscode.window.activeTextEditor;
        promptId = active ? store.findByMarkdownPath(active.document.uri.fsPath)?.id : undefined;
      }
      if (!promptId) {
        void vscode.window.showWarningMessage(
          "Abra um prompt do Sobek (prompt.md) ou use o menu da árvore para refinar."
        );
        return;
      }
      const prompt = store.require(promptId);
      if (prompt.content.trim().length === 0) {
        void vscode.window.showWarningMessage("O prompt está vazio; escreva algo antes de refinar.");
        return;
      }

      let refined: string;
      try {
        refined = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Sobek: refinando prompt com Gemini...",
            cancellable: true,
          },
          async (_progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            return ai.refine(prompt.content, controller.signal);
          }
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        void vscode.window.showErrorMessage(`Refinamento falhou: ${(error as Error).message}`);
        return;
      }
      if (!refined) {
        void vscode.window.showWarningMessage("O Gemini retornou uma resposta vazia.");
        return;
      }

      const originalUri = previews.set(`${prompt.id}-original`, prompt.content);
      const refinedUri = previews.set(`${prompt.id}-refinado`, refined);
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        refinedUri,
        `Refinar: ${prompt.title}`,
        { preview: true }
      );

      const action = await vscode.window.showInformationMessage(
        "Aplicar o prompt refinado?",
        "Aplicar",
        "Descartar"
      );
      if (action !== "Aplicar") {
        return;
      }
      await store.update(prompt.id, { content: refined });
      // Refresh the on-disk document if it is open in an editor.
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === store.promptMarkdownPath(prompt.id)
      );
      if (document && document.getText() !== refined) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          refined
        );
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
      void vscode.window.showInformationMessage("Prompt refinado aplicado (nova versão criada).");
    }),

    vscode.commands.registerCommand("sobek.setGeminiApiKey", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Chave da Gemini API (deixe vazio para remover)",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      await ai.setApiKey(value.trim() || undefined);
      void vscode.window.showInformationMessage(
        value.trim() ? "Chave Gemini salva no SecretStorage." : "Chave Gemini removida."
      );
    })
  );
}
