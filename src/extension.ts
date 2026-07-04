import * as vscode from "vscode";
import { AiService } from "./ai/service";
import { defaultPhaseTemplateForLocale } from "./core/workflow";
import { WorkspaceFileIndex } from "./language/file-index";
import { extendMarkdownItWithMentions } from "./language/markdown-preview";
import { MentionDecorations } from "./language/mention-decorations";
import {
  MentionCompletionProvider,
  MentionDiagnostics,
  MentionLinkProvider,
  registerMentionRetrigger,
} from "./language/mention-features";
import { PromptStore } from "./store/prompt-store";
import { getWorkspaceRoot } from "./store/workspace";
import { TerminalManager } from "./terminals/manager";
import {
  offerAgentTerminalForChild,
  registerTerminalCommands,
} from "./terminals/terminal-commands";
import { registerTerminalsView } from "./terminals/terminals-view";
import { AssistantViewProvider } from "./ui/assistant-view";
import { BoardPanel } from "./ui/board-panel";
import { CHILD_PREVIEW_SCHEME, ChildPromptPreviewProvider } from "./ui/child-preview";
import { registerRefineCommand } from "./ui/refine-command";
import { UsageStatusBar } from "./ui/usage-status";
import { registerGenerateChildCommands } from "./ui/generate-child";
import { registerPromptCommands } from "./ui/prompt-commands";
import { PromptTreeProvider } from "./ui/tree";
import { registerWorkflowCommands } from "./ui/workflow-commands";

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  try {
    await initialize(context);
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Sobek failed to activate: {0}", (error as Error).message)
    );
    throw error;
  }
  // Consumed by the built-in Markdown extension (markdown.markdownItPlugins).
  return {
    extendMarkdownIt: (md: unknown) => extendMarkdownItWithMentions(md, getWorkspaceRoot),
  };
}

/**
 * Without a folder open there is no target workspace; commands still need to
 * exist (the view buttons are always visible), so they explain the state.
 */
function registerNoWorkspaceFallback(context: vscode.ExtensionContext): void {
  const warn = () =>
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Open a folder to use Sobek: the open workspace is the target directory for prompts."
      )
    );
  const commands = [
    "sobek.createPrompt",
    "sobek.refreshPrompts",
    "sobek.openPrompt",
    "sobek.openBoard",
    "sobek.generateChildPrompt",
    "sobek.newWorkspaceTerminal",
    "sobek.refinePrompt",
    "sobek.setGeminiApiKey",
  ];
  for (const id of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, warn));
  }
}

async function initialize(context: vscode.ExtensionContext): Promise<void> {
  // Sobek targets the open VS Code workspace: no directory registration step.
  const workspaceRoot = getWorkspaceRoot();
  await vscode.commands.executeCommand("setContext", "sobek.hasWorkspace", !!workspaceRoot);
  if (!workspaceRoot) {
    registerNoWorkspaceFallback(context);
    return;
  }

  const store = new PromptStore(
    workspaceRoot,
    defaultPhaseTemplateForLocale(vscode.env.language)
  );
  await store.load();

  const fileIndex = new WorkspaceFileIndex(workspaceRoot);
  fileIndex.register(context);

  // Workspace-defined child templates reload live as their files change.
  const templatesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, ".sobek/templates/*.md")
  );
  context.subscriptions.push(
    templatesWatcher,
    templatesWatcher.onDidCreate(() => void store.reloadCustomTemplates()),
    templatesWatcher.onDidChange(() => void store.reloadCustomTemplates()),
    templatesWatcher.onDidDelete(() => void store.reloadCustomTemplates())
  );

  const tree = new PromptTreeProvider(store);
  context.subscriptions.push(
    vscode.window.createTreeView("sobekPrompts", { treeDataProvider: tree, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(
      CHILD_PREVIEW_SCHEME,
      new ChildPromptPreviewProvider(store)
    ),
    vscode.commands.registerCommand("sobek.refreshPrompts", async () => {
      fileIndex.refresh();
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
  registerTerminalsView(context, store, terminals);
  registerWorkflowCommands(context, store);

  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.openBoard", () => {
      BoardPanel.show(context, store);
    })
  );

  const ai = new AiService(context, workspaceRoot, store);
  registerRefineCommand(context, store, ai);

  if (vscode.workspace.getConfiguration("sobek.usage").get<boolean>("enabled", true)) {
    const usage = new UsageStatusBar(context);
    terminals.onAgentLaunch = () => usage.recordActivity();
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewType,
      new AssistantViewProvider(context, store, ai, fileIndex)
    )
  );

  const markdownSelector: vscode.DocumentSelector = { language: "markdown", scheme: "file" };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      markdownSelector,
      new MentionCompletionProvider(store, fileIndex),
      "@"
    ),
    vscode.languages.registerDocumentLinkProvider(
      markdownSelector,
      new MentionLinkProvider(store, workspaceRoot)
    )
  );
  new MentionDiagnostics(store, workspaceRoot).register(context);
  new MentionDecorations(store, workspaceRoot).register(context);
  registerMentionRetrigger(context, store);
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
