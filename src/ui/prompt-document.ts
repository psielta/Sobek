import * as vscode from "vscode";
import type { PromptStore } from "../store/prompt-store";

/**
 * Syncs the on-disk prompt document with freshly written content when it is
 * open in an editor, so store updates show up without a manual reload.
 */
export async function refreshPromptDocument(
  store: PromptStore,
  promptId: string,
  content: string
): Promise<void> {
  const document = vscode.workspace.textDocuments.find(
    (candidate) => candidate.uri.fsPath === store.promptMarkdownPath(promptId)
  );
  if (!document || document.getText() === content) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    content
  );
  await vscode.workspace.applyEdit(edit);
  await document.save();
}
