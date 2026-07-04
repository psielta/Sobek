import * as vscode from "vscode";
import { GeminiClient, type GeminiMessage, type GeminiStreamChunk } from "./gemini-client";
import {
  buildChatSystemInstruction,
  buildChatUserMessage,
  buildRefineSystemInstruction,
} from "./instructions";
import {
  DEFAULT_AI_SETTINGS,
  findModel,
  GEMINI_MODELS,
  type AiSettings,
  type ThinkingLevel,
} from "./models";
import { readWorkspaceContext } from "./workspace-context";

const API_KEY_SECRET = "sobek.geminiApiKey";

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

/** Extension-host Gemini service: settings, secrets and the two AI flows. */
export class AiService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string
  ) {}

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(API_KEY_SECRET);
  }

  async setApiKey(value: string | undefined): Promise<void> {
    if (value) {
      await this.context.secrets.store(API_KEY_SECRET, value);
    } else {
      await this.context.secrets.delete(API_KEY_SECRET);
    }
  }

  getSettings(): AiSettings {
    const config = vscode.workspace.getConfiguration("sobek.ai");
    const model = config.get<string>("model", DEFAULT_AI_SETTINGS.model);
    const info = findModel(model);
    const budget = config.get<number | null>("thinkingBudget", null);
    return {
      model: info ? model : DEFAULT_AI_SETTINGS.model,
      temperature: config.get<number>("temperature", DEFAULT_AI_SETTINGS.temperature),
      thinkingEnabled: config.get<boolean>("thinkingEnabled", true),
      thinkingBudget: info?.thinkingMode === "budget" ? budget : null,
      thinkingLevel: config.get<ThinkingLevel>("thinkingLevel", "high"),
    };
  }

  private async createClient(): Promise<GeminiClient> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'IA indisponível: configure a chave Gemini com o comando "Sobek: Configurar chave Gemini".'
      );
    }
    return new GeminiClient({ apiKey });
  }

  private thinkingFor(settings: AiSettings) {
    const info = findModel(settings.model);
    if (!info || info.thinkingMode === "none") {
      return { mode: "none" as const };
    }
    if (info.thinkingMode === "budget") {
      if (!settings.thinkingEnabled && info.canDisableThinking) {
        return { mode: "budget" as const, budget: 0 };
      }
      return {
        mode: "budget" as const,
        budget: settings.thinkingBudget ?? Math.min(8192, info.budgetMax),
      };
    }
    // Level-mode models cannot disable thinking (canDisableThinking=false).
    return { mode: "level" as const, level: settings.thinkingLevel ?? "high" };
  }

  private async workspaceContext(): Promise<string | undefined> {
    const enabled = vscode.workspace
      .getConfiguration("sobek.ai")
      .get<boolean>("useWorkspaceContext", false);
    if (!enabled) {
      return undefined;
    }
    return readWorkspaceContext(this.workspaceRoot);
  }

  /** Prompt refinement: single-shot, no thoughts, refine temperature. */
  async refine(content: string, signal?: AbortSignal): Promise<string> {
    const client = await this.createClient();
    const settings = this.getSettings();
    const context = await this.workspaceContext();
    const result = await client.generate({
      model: settings.model,
      systemInstruction: buildRefineSystemInstruction(context),
      messages: [{ role: "user", text: content }],
      temperature: settings.temperature,
      thinking: this.thinkingFor(settings),
      includeThoughts: false,
      signal,
    });
    return result.text.trim();
  }

  /** Support chat: streams deltas, thoughts included like Thoth's drawer. */
  async *chat(
    history: ChatTurn[],
    message: string,
    promptContent: string | undefined,
    signal?: AbortSignal
  ): AsyncGenerator<GeminiStreamChunk> {
    const client = await this.createClient();
    const settings = this.getSettings();
    const context = await this.workspaceContext();
    const messages: GeminiMessage[] = [
      ...history.map((turn) => ({ role: turn.role, text: turn.text })),
      { role: "user" as const, text: buildChatUserMessage(message, promptContent) },
    ];
    yield* client.stream({
      model: settings.model,
      systemInstruction: buildChatSystemInstruction(context),
      messages,
      temperature: settings.temperature,
      thinking: this.thinkingFor(settings),
      includeThoughts: true,
      signal,
    });
  }

  listModels() {
    return GEMINI_MODELS;
  }
}
