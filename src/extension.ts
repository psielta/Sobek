import * as vscode from "vscode";
import { AiService } from "./ai/service";
import {
  MentionCompletionProvider,
  MentionDiagnostics,
  MentionLinkProvider,
} from "./language/mention-features";
import { PromptStore } from "./store/prompt-store";
import { getWorkspaceRoot } from "./store/workspace";
import { TerminalManager } from "./terminals/manager";
import {
  offerAgentTerminalForChild,
  registerTerminalCommands,
} from "./terminals/terminal-commands";
import { AssistantViewProvider } from "./ui/assistant-view";
import { BoardPanel } from "./ui/board-panel";
import { CHILD_PREVIEW_SCHEME, ChildPromptPreviewProvider } from "./ui/child-preview";
import { registerRefineCommand } from "./ui/refine-command";
import { registerGenerateChildCommands } from "./ui/generate-child";
import { registerPromptCommands } from "./ui/prompt-commands";
import { PromptTreeProvider } from "./ui/tree";
import { registerWorkflowCommands } from "./ui/workflow-commands";

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

  const terminals = new TerminalManager(store, context);
  store.onDidArchive((promptId) => terminals.killForPrompt(promptId));

  registerPromptCommands(context, store);
  registerGenerateChildCommands(context, store, (child) =>
    offerAgentTerminalForChild(terminals, child)
  );
  registerTerminalCommands(context, store, terminals);
  registerWorkflowCommands(context, store);

  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.openBoard", () => {
      BoardPanel.show(context, store);
    })
  );

  const ai = new AiService(context, workspaceRoot);
  registerRefineCommand(context, store, ai);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewType,
      new AssistantViewProvider(context, store, ai)
    )
  );

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
