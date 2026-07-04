import * as vscode from "vscode";
import type { PromptStore } from "../store/prompt-store";

export const CHILD_PREVIEW_SCHEME = "sobek-child";

/**
 * Read-only view for child prompts — the extension counterpart of Thoth's
 * child prompt drawer: children are inspected and copied, never edited in
 * place of the parent context.
 */
export class ChildPromptPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly store: PromptStore) {
    store.onDidChange(() => {
      // Content may have changed for any open preview; VS Code re-requests lazily.
    });
  }

  static uriFor(promptId: string, title: string): vscode.Uri {
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_") || "prompt-filho";
    return vscode.Uri.parse(`${CHILD_PREVIEW_SCHEME}:/${promptId}/${safeTitle}.md`);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const promptId = uri.path.replace(/^\//, "").split("/")[0];
    const prompt = this.store.get(promptId);
    if (!prompt) {
      return "Prompt filho não encontrado.";
    }
    return prompt.content;
  }
}
