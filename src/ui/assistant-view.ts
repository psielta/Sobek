import * as vscode from "vscode";
import { buildChatUserMessage } from "../ai/instructions";
import type { AiService, ChatTurn } from "../ai/service";
import type { WorkspaceFileIndex } from "../language/file-index";
import type { PromptStore } from "../store/prompt-store";
import { buildWebviewHtml } from "../lib/webview-html";
import { CHILD_PREVIEW_SCHEME } from "./child-preview";

/**
 * Sidebar chat specialized in prompt engineering — Sobek's counterpart of
 * Thoth's AI drawer. History lives per VS Code session; the current prompt
 * (active prompt.md editor) can be attached as context to a message.
 */
export class AssistantViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "sobekAssistant";
  private view: vscode.WebviewView | undefined;
  private history: ChatTurn[] = [];
  private streaming: AbortController | undefined;
  private activePromptId: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: PromptStore,
    private readonly ai: AiService,
    private readonly fileIndex: WorkspaceFileIndex
  ) {
    // Track which prompt is the chat context. Focusing the webview clears
    // activeTextEditor, so the last resolved prompt is kept sticky until the
    // user opens a different file.
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.updateActivePrompt(editor);
        this.postActivePrompt();
      })
    );
    store.onDidChange(() => this.postActivePrompt());
    this.updateActivePrompt(vscode.window.activeTextEditor);
  }

  private updateActivePrompt(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      return; // webview/panel got focus — keep the last prompt
    }
    const uri = editor.document.uri;
    if (uri.scheme === "file") {
      this.activePromptId = this.store.findByMarkdownPath(uri.fsPath)?.id;
      return;
    }
    if (uri.scheme === CHILD_PREVIEW_SCHEME) {
      const id = uri.path.replace(/^\//, "").split("/")[0];
      this.activePromptId = this.store.get(id)?.id;
    }
    // Other schemes (diffs, output, previews) do not change the context.
  }

  private activePromptSummary(): { id: string; title: string; isChild: boolean } | null {
    const prompt = this.activePromptId ? this.store.get(this.activePromptId) : undefined;
    if (!prompt) {
      return null;
    }
    return {
      id: prompt.id,
      title: prompt.title || "(sem título)",
      isChild: !!prompt.parentPromptId,
    };
  }

  private postActivePrompt(): void {
    this.post({ type: "activePrompt", prompt: this.activePromptSummary() });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = buildWebviewHtml({
      webview: view.webview,
      extensionUri: this.context.extensionUri,
      entry: "assistant",
      title: "Sobek: IA",
      initialState: {
        history: this.history,
        models: this.ai.listModels(),
        settings: this.ai.getSettings(),
        activePrompt: this.activePromptSummary(),
      },
    });
    view.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }


  private async handleMessage(message: {
    type: string;
    text?: string;
    includePromptContext?: boolean;
    query?: string;
    requestId?: number;
  }): Promise<void> {
    switch (message.type) {
      case "searchFiles": {
        const files = await this.fileIndex.search(message.query ?? "", 30);
        this.post({ type: "fileResults", requestId: message.requestId, files });
        break;
      }
      case "ready":
        this.post({
          type: "init",
          history: this.history,
          models: this.ai.listModels(),
          settings: this.ai.getSettings(),
          activePrompt: this.activePromptSummary(),
        });
        break;
      case "send":
        await this.send(message.text ?? "", message.includePromptContext === true);
        break;
      case "stop":
        this.streaming?.abort();
        break;
      case "clear":
        this.streaming?.abort();
        this.history = [];
        this.post({ type: "cleared" });
        break;
      case "configure":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:psielta.sobek ai"
        );
        break;
      case "setApiKey":
        await vscode.commands.executeCommand("sobek.setGeminiApiKey");
        break;
    }
  }

  private async send(text: string, includePromptContext: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.streaming) {
      return;
    }
    const prompt =
      includePromptContext && this.activePromptId
        ? this.store.get(this.activePromptId)
        : undefined;
    if (includePromptContext && !prompt) {
      this.post({
        type: "error",
        message: "Nenhum prompt ativo: abra o prompt.md de um prompt do Sobek.",
      });
      return;
    }

    // The persisted user turn embeds the prompt context, like Thoth does.
    const history = [...this.history];
    this.post({ type: "userMessage", text: trimmed });
    this.streaming = new AbortController();
    let answer = "";
    try {
      for await (const chunk of this.ai.chat(history, trimmed, prompt, this.streaming.signal)) {
        if (!chunk.isThought) {
          answer += chunk.text;
        }
        this.post({ type: "chunk", text: chunk.text, isThought: chunk.isThought });
      }
      this.history.push(
        { role: "user", text: buildChatUserMessage(trimmed, prompt?.content) },
        { role: "model", text: answer }
      );
      this.post({ type: "done" });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        this.post({ type: "error", message: (error as Error).message });
      } else {
        this.post({ type: "done" });
      }
    } finally {
      this.streaming = undefined;
    }
  }
}
