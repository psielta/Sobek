import * as vscode from "vscode";
import { validateMentions } from "../core/mentions";
import type { PromptStore } from "../store/prompt-store";
import { CHILD_PREVIEW_SCHEME } from "../ui/child-preview";

const REFINE_PREVIEW_SCHEME = "sobek-refine";

/**
 * Highlights `@file` mentions in prompt surfaces: link color for mentions
 * that resolve to a workspace file, warning color for broken ones. Applies
 * to prompt.md editors, the read-only child preview and refine diffs.
 */
export class MentionDecorations {
  private readonly valid = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("textLink.foreground"),
    fontWeight: "600",
  });
  private readonly broken = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor("editorWarning.foreground"),
    fontWeight: "600",
  });
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: PromptStore,
    private readonly workspaceRoot: string
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.valid,
      this.broken,
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isMentionDocument(event.document)) {
          this.schedule();
        }
      }),
      new vscode.Disposable(() => clearTimeout(this.timer))
    );
    this.schedule();
  }

  private isMentionDocument(document: vscode.TextDocument): boolean {
    if (
      document.uri.scheme === CHILD_PREVIEW_SCHEME ||
      document.uri.scheme === REFINE_PREVIEW_SCHEME
    ) {
      return true;
    }
    return (
      document.languageId === "markdown" &&
      document.uri.scheme === "file" &&
      this.store.findByMarkdownPath(document.uri.fsPath) !== undefined
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.apply(), 300);
  }

  private async apply(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!this.isMentionDocument(editor.document)) {
        continue;
      }
      const text = editor.document.getText();
      const { mentions, issues } = await validateMentions(this.workspaceRoot, text);
      const brokenStarts = new Set(issues.map((issue) => issue.mention.start));
      const validRanges: vscode.Range[] = [];
      const brokenRanges: vscode.Range[] = [];
      for (const mention of mentions) {
        const range = new vscode.Range(
          editor.document.positionAt(mention.start),
          editor.document.positionAt(mention.end)
        );
        (brokenStarts.has(mention.start) ? brokenRanges : validRanges).push(range);
      }
      editor.setDecorations(this.valid, validRanges);
      editor.setDecorations(this.broken, brokenRanges);
    }
  }
}
