import * as vscode from "vscode";
import { buildChatUserMessage } from "../ai/instructions";
import type { AiService, ChatTurn } from "../ai/service";
import type { PromptStore } from "../store/prompt-store";
import { buildWebviewHtml } from "../lib/webview-html";

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: PromptStore,
    private readonly ai: AiService
  ) {}

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
      },
    });
    view.webview.onDidReceiveMessage((message) => void this.handleMessage(message));
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private activePrompt() {
    const active = vscode.window.activeTextEditor;
    if (!active) {
      return undefined;
    }
    return this.store.findByMarkdownPath(active.document.uri.fsPath);
  }

  private async handleMessage(message: {
    type: string;
    text?: string;
    includePromptContext?: boolean;
  }): Promise<void> {
    switch (message.type) {
      case "ready":
        this.post({
          type: "init",
          history: this.history,
          models: this.ai.listModels(),
          settings: this.ai.getSettings(),
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
    const prompt = includePromptContext ? this.activePrompt() : undefined;
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
