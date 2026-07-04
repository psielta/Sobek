import * as vscode from "vscode";
import * as path from "node:path";

export const SOBEK_DIR = ".sobek";

/**
 * Sobek targets the currently open VS Code workspace: the first workspace
 * folder is the working directory every prompt is bound to.
 */
export function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

export function requireWorkspaceRoot(): string {
  const root = getWorkspaceRoot();
  if (!root) {
    throw new Error(
      "Sobek requires an open folder: the workspace is the target directory for prompts."
    );
  }
  return root;
}

export function getSobekDir(root: string): string {
  return path.join(root, SOBEK_DIR);
}
