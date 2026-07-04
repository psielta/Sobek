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
    const match = /(^|[\s([{])@([\w./\\-]*)$/.exec(linePrefix);
    if (!match) {
      return undefined;
    }
    const query = match[2] ?? "";
    const relatives = await this.index.search(query, 100);
    const replaceStart = position.character - query.length;
    const range = new vscode.Range(position.line, replaceStart, position.line, position.character);
    const items = relatives.map((relative, order) => {
      const item = new vscode.CompletionItem(relative, vscode.CompletionItemKind.File);
      item.insertText = relative;
      // Filter on the whole relative path so typing "src/ma" keeps matching.
      item.filterText = relative;
      item.sortText = String(order).padStart(4, "0");
      item.range = range;
      item.detail = "Menção de arquivo do workspace";
      return item;
    });
    // isIncomplete makes VS Code re-query on every keystroke (including
    // deletions) instead of filtering a stale list — the Copilot approach.
    return new vscode.CompletionList(items, true);
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
            ? `A menção @${issue.mention.raw} escapa do diretório do workspace.`
            : issue.reason === "not-a-file"
              ? `A menção @${issue.mention.raw} aponta para um diretório, não um arquivo.`
              : `Arquivo não encontrado no workspace: ${issue.mention.raw}`;
        const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
        diagnostic.source = "sobek";
        return diagnostic;
      })
    );
  }
}

/** Makes `@path` mentions clickable, opening the referenced file. */
export class MentionLinkProvider implements vscode.DocumentLinkProvider {
  constructor(
    private readonly store: PromptStore,
    private readonly workspaceRoot: string
  ) {}

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] | undefined {
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
      const link = new vscode.DocumentLink(range, vscode.Uri.file(resolved));
      link.tooltip = "Abrir arquivo mencionado";
      links.push(link);
    }
    return links;
  }
}
