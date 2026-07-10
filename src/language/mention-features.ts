import * as vscode from "vscode";
import { parseMentions, resolveMentionPath, validateMentions } from "../core/mentions";
import type { PromptStore } from "../store/prompt-store";
import type { WorkspaceFileIndex } from "./file-index";

function isPromptDocument(store: PromptStore, document: vscode.TextDocument): boolean {
  return (
    document.languageId === "markdown" &&
    store.findByMarkdownPath(document.uri.fsPath) !== undefined
  );
}

/** `@` completion listing workspace files, like Thoth's TipTap mention picker. */
export class MentionCompletionProvider implements vscode.CompletionItemProvider {
  private lastResult:
    | { uri: string; version: number; query: string; list: vscode.CompletionList }
    | undefined;

  constructor(
    private readonly store: PromptStore,
    private readonly index: WorkspaceFileIndex
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionList | undefined> {
    if (!isPromptDocument(this.store, document)) {
      return undefined;
    }
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const match = /(^|[\s([{])@([\w./\\()-]*)$/.exec(linePrefix);
    if (!match) {
      return undefined;
    }
    const query = match[2] ?? "";

    // The native isIncomplete re-query and the retrigger listener can both
    // fire for the same keystroke; serve the second call from cache.
    const cached = this.lastResult;
    if (
      cached &&
      cached.uri === document.uri.toString() &&
      cached.version === document.version &&
      cached.query === query
    ) {
      return cached.list;
    }
    const replaceStart = position.character - query.length;
    const range = new vscode.Range(position.line, replaceStart, position.line, position.character);

    const buildItem = (relative: string, order: number): vscode.CompletionItem => {
      const isDirectory = relative.endsWith("/");
      const item = new vscode.CompletionItem(
        relative,
        isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File
      );
      item.insertText = relative;
      // Filter on the whole relative path so typing "src/ma" keeps matching.
      item.filterText = relative;
      item.sortText = String(order).padStart(5, "0");
      item.range = range;
      item.detail = isDirectory
        ? vscode.l10n.t("Workspace directory mention")
        : vscode.l10n.t("Workspace file mention");
      // The suggest widget truncates long labels; the docs panel (chevron or
      // Ctrl+Space) is the only place the full path can be read.
      item.documentation = new vscode.MarkdownString().appendCodeblock(relative);
      if (isDirectory) {
        // Drill-down: accepting "src/" reopens the widget searching inside it.
        item.command = {
          command: "editor.action.triggerSuggest",
          title: vscode.l10n.t("Keep searching inside the folder"),
        };
      }
      return item;
    };

    // Small ranked payload per invocation: the retrigger listener re-queries
    // on every keystroke (typing and deleting), so each response only needs
    // the best matches — shipping thousands of items per key was the lag.
    const ranked = await this.index.search(query, 100);
    const list = new vscode.CompletionList(ranked.map(buildItem), true);
    this.lastResult = {
      uri: document.uri.toString(),
      version: document.version,
      query,
      list,
    };
    return list;
  }
}

/** Squiggles for mentions that do not resolve to an existing workspace file. */
export class MentionDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: PromptStore,
    private readonly workspaceRoot: string
  ) {
    this.collection = vscode.languages.createDiagnosticCollection("sobek-mentions");
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((document) => this.schedule(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.collection.delete(document.uri))
    );
    for (const document of vscode.workspace.textDocuments) {
      this.schedule(document);
    }
  }

  private schedule(document: vscode.TextDocument): void {
    if (!isPromptDocument(this.store, document)) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(document), 400);
  }

  private async run(document: vscode.TextDocument): Promise<void> {
    const text = document.getText();
    const { issues } = await validateMentions(this.workspaceRoot, text);
    this.collection.set(
      document.uri,
      issues.map((issue) => {
        const range = new vscode.Range(
          document.positionAt(issue.mention.start),
          document.positionAt(issue.mention.end)
        );
        const message =
          issue.reason === "outside-workspace"
            ? vscode.l10n.t("The mention @{0} escapes the workspace directory.", issue.mention.raw)
            : issue.reason === "not-a-file"
              ? vscode.l10n.t(
                  "The mention @{0} points to something that is not a file or directory.",
                  issue.mention.raw
                )
              : issue.reason === "not-a-directory"
                ? vscode.l10n.t(
                    "The mention @{0} has a trailing slash but points to a file.",
                    issue.mention.raw
                  )
                : vscode.l10n.t("File not found in the workspace: {0}", issue.mention.raw);
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = "sobek";
        return diagnostic;
      })
    );
  }
}

const MENTION_TOKEN_AT_CURSOR = /(^|[\s([{])@([\w./\\()-]*)$/;

/**
 * Keeps the suggest widget alive while typing OR deleting inside an `@`
 * token. VS Code never re-queries providers on backspace and markdown has
 * quick suggestions disabled, so once the widget closes (e.g. zero matches)
 * it would stay closed until the user retyped the mention — this re-triggers
 * it programmatically, giving the always-live search Claude Code has.
 */
export function registerMentionRetrigger(
  context: vscode.ExtensionContext,
  store: PromptStore
): void {
  let debounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (
        !editor ||
        editor.document !== event.document ||
        event.contentChanges.length === 0 ||
        !isPromptDocument(store, event.document)
      ) {
        return;
      }
      // Only single-character typing/deletions keep the search alive;
      // accepting a completion or pasting must not reopen the widget.
      const isKeystroke = event.contentChanges.every((change) => change.text.length <= 1);
      if (!isKeystroke) {
        return;
      }
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const active = vscode.window.activeTextEditor;
        if (!active || active.document !== event.document) {
          return;
        }
        const position = active.selection.active;
        const linePrefix = active.document.lineAt(position.line).text.slice(0, position.character);
        if (MENTION_TOKEN_AT_CURSOR.test(linePrefix)) {
          void vscode.commands.executeCommand("editor.action.triggerSuggest");
        }
      }, 50);
    }),
    new vscode.Disposable(() => clearTimeout(debounce))
  );
}

/** Makes `@path` mentions clickable: files open, folders reveal in Explorer. */
export class MentionLinkProvider implements vscode.DocumentLinkProvider {
  constructor(
    private readonly store: PromptStore,
    private readonly workspaceRoot: string
  ) {}

  async provideDocumentLinks(
    document: vscode.TextDocument
  ): Promise<vscode.DocumentLink[] | undefined> {
    if (!isPromptDocument(this.store, document)) {
      return undefined;
    }
    const links: vscode.DocumentLink[] = [];
    for (const mention of parseMentions(document.getText())) {
      const resolved = resolveMentionPath(this.workspaceRoot, mention.raw);
      if (!resolved) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(mention.start),
        document.positionAt(mention.end)
      );
      const uri = vscode.Uri.file(resolved);
      let isDirectory = false;
      try {
        isDirectory = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
      } catch {
        // Unresolvable mention: keep the file-link behavior (open attempt).
      }
      const link = isDirectory
        ? new vscode.DocumentLink(
            range,
            vscode.Uri.parse(`command:revealInExplorer?${encodeURIComponent(JSON.stringify(uri))}`)
          )
        : new vscode.DocumentLink(range, uri);
      link.tooltip = isDirectory
        ? vscode.l10n.t("Reveal mentioned folder in Explorer")
        : vscode.l10n.t("Open mentioned file");
      links.push(link);
    }
    return links;
  }
}
