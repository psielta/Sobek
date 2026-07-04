import * as vscode from "vscode";
import {
  MentionCompletionProvider,
  MentionDiagnostics,
  MentionLinkProvider,
} from "./language/mention-features";
import { PromptStore } from "./store/prompt-store";
import { getWorkspaceRoot } from "./store/workspace";
import { CHILD_PREVIEW_SCHEME, ChildPromptPreviewProvider } from "./ui/child-preview";
import { registerPromptCommands } from "./ui/prompt-commands";
import { PromptTreeProvider } from "./ui/tree";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Sobek targets the open VS Code workspace: no directory registration step.
  const workspaceRoot = getWorkspaceRoot();
  await vscode.commands.executeCommand("setContext", "sobek.hasWorkspace", !!workspaceRoot);
  if (!workspaceRoot) {
    return;
  }

  const store = new PromptStore(workspaceRoot);
  await store.load();

  const tree = new PromptTreeProvider(store);
  context.subscriptions.push(
    vscode.window.createTreeView("sobekPrompts", { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(
      CHILD_PREVIEW_SCHEME,
      new ChildPromptPreviewProvider(store)
    ),
    vscode.commands.registerCommand("sobek.refreshPrompts", async () => {
      await store.load();
    })
  );

  registerPromptCommands(context, store);

  const markdownSelector: vscode.DocumentSelector = { language: "markdown", scheme: "file" };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      markdownSelector,
      new MentionCompletionProvider(store, workspaceRoot),
      "@"
    ),
    vscode.languages.registerDocumentLinkProvider(
      markdownSelector,
      new MentionLinkProvider(store, workspaceRoot)
    )
  );
  new MentionDiagnostics(store, workspaceRoot).register(context);
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
