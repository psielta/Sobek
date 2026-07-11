import * as vscode from "vscode";
import * as path from "node:path";
import type { AiService } from "../ai/service";
import type { PromptStore } from "../store/prompt-store";
import { refreshPromptDocument } from "./prompt-document";
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
          vscode.l10n.t("Open a Sobek prompt (prompt.md) or use the tree menu to refine.")
        );
        return;
      }
      const prompt = store.require(promptId);
      if (prompt.content.trim().length === 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("The prompt is empty; write something before refining.")
        );
        return;
      }

      // Optional per-call context, like Thoth's refine dialog: selected files
      // (Enter with nothing selected skips) and custom instructions.
      const files = await vscode.workspace.findFiles(
        "**/*",
        "{**/node_modules/**,**/.sobek/**,**/.git/**,**/dist/**,**/build/**,**/bin/**,**/obj/**}",
        300
      );
      const pickedFiles = await vscode.window.showQuickPick(
        files
          .map((uri) => {
            const relative = path.relative(store.root, uri.fsPath).replace(/\\/g, "/");
            return { label: path.basename(uri.fsPath), description: relative };
          })
          .sort((a, b) => a.description.localeCompare(b.description)),
        {
          canPickMany: true,
          placeHolder: vscode.l10n.t(
            "Context files for the refinement (optional — Enter with no selection to skip)"
          ),
          matchOnDescription: true,
        }
      );
      if (pickedFiles === undefined) {
        return;
      }
      const customInstructions = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Additional refinement instructions (optional — Enter to skip)"),
        placeHolder: vscode.l10n.t("E.g.: keep the prompt short and as a checklist"),
        ignoreFocusOut: true,
      });
      if (customInstructions === undefined) {
        return;
      }

      let refined: string;
      try {
        refined = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("Sobek: refining prompt with Gemini..."),
            cancellable: true,
          },
          async (_progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            return ai.refine({
              content: prompt.content,
              prompt,
              contextFiles: pickedFiles.map((item) => item.description as string),
              customInstructions: customInstructions.trim() || undefined,
              signal: controller.signal,
            });
          }
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          return;
        }
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Refinement failed: {0}", (error as Error).message)
        );
        return;
      }
      if (!refined) {
        void vscode.window.showWarningMessage(vscode.l10n.t("Gemini returned an empty response."));
        return;
      }

      const originalUri = previews.set(`${prompt.id}-original`, prompt.content);
      const refinedUri = previews.set(`${prompt.id}-refined`, refined);
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        refinedUri,
        vscode.l10n.t("Refine: {0}", prompt.title),
        { preview: true }
      );

      const applyLabel = vscode.l10n.t("Apply");
      const action = await vscode.window.showInformationMessage(
        vscode.l10n.t("Apply the refined prompt?"),
        applyLabel,
        vscode.l10n.t("Discard")
      );
      if (action !== applyLabel) {
        return;
      }
      await store.update(prompt.id, { content: refined });
      await refreshPromptDocument(store, prompt.id, refined);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Refined prompt applied (new version created).")
      );
    }),

    vscode.commands.registerCommand("sobek.setGeminiApiKey", async () => {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Gemini API key (leave empty to remove)"),
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) {
        return;
      }
      await ai.setApiKey(value.trim() || undefined);
      void vscode.window.showInformationMessage(
        value.trim()
          ? vscode.l10n.t("Gemini key saved to SecretStorage.")
          : vscode.l10n.t("Gemini key removed.")
      );
    })
  );
}
