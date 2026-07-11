import * as vscode from "vscode";
import { parseMentions } from "../core/mentions";
import type { Prompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import { buildPromptContext, readSelectedFiles } from "./context-builder";
import { GeminiClient, type GeminiContent } from "./gemini-client";
import {
  buildChatSystemInstruction,
  buildChatUserMessage,
  buildCustomInstructionsBlock,
  buildMentionedFilesBlock,
  buildRefineSystemInstruction,
  buildToolGuidanceBlock,
} from "./instructions";
import { ASSISTANT_TOOLS } from "./tool-declarations";
import { runToolLoop } from "./tool-loop";
import type { AssistantToolExecutor } from "./tools";
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
  /** Tool calls executed while producing a model turn (chip metadata). */
  tools?: Array<{ name: string; ok: boolean }>;
}

/** Chat output: streamed text/thought deltas plus tool activity updates. */
export type ChatEvent =
  | { type: "text"; text: string; isThought: boolean }
  | {
      type: "tool";
      callId: number;
      name: string;
      status: "running" | "ok" | "error";
      detail?: string;
    };

export interface RefineOptions {
  content: string;
  /** The Sobek prompt being refined, when known — enables derived context. */
  prompt?: Prompt;
  /** Workspace-relative paths chosen by the user for this refinement. */
  contextFiles?: string[];
  customInstructions?: string;
  signal?: AbortSignal;
}

/** Extension-host Gemini service: settings, secrets and the two AI flows. */
export class AiService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly store: PromptStore
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
      toolsEnabled: config.get<boolean>("enableTools", true),
    };
  }

  private async createClient(): Promise<GeminiClient> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        vscode.l10n.t(
          'AI unavailable: set the Gemini key with the "Sobek: Set Gemini API Key" command.'
        )
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

  /**
   * Prompt refinement: single-shot, no thoughts. System instruction follows
   * Thoth's order — base, workspace context, selected files (plus Sobek's
   * derived blocks: mentions, plan, parent, workflow, git), custom
   * instructions — all joined by blank lines.
   */
  async refine(options: RefineOptions): Promise<string> {
    const client = await this.createClient();
    const settings = this.getSettings();
    const parts: string[] = [];
    const workspaceContext = await this.workspaceContext();
    if (workspaceContext) {
      parts.push(workspaceContext);
    }
    const promptContext = await buildPromptContext(this.store, options.prompt, {
      contextFiles: options.contextFiles,
    });
    if (promptContext) {
      parts.push(promptContext);
    }
    const custom = options.customInstructions
      ? buildCustomInstructionsBlock(options.customInstructions)
      : undefined;
    if (custom) {
      parts.push(custom);
    }
    const result = await client.generate({
      model: settings.model,
      systemInstruction: buildRefineSystemInstruction(
        parts.length > 0 ? parts.join("\n\n") : undefined
      ),
      messages: [{ role: "user", text: options.content }],
      temperature: settings.temperature,
      thinking: this.thinkingFor(settings),
      includeThoughts: false,
      signal: options.signal,
    });
    return result.text.trim();
  }

  /**
   * Support chat: streams deltas, thoughts included like Thoth's drawer.
   * With an executor, the model may call prompt tools (function calling);
   * the loop feeds tool results back until the model answers in prose.
   */
  async *chat(
    history: ChatTurn[],
    message: string,
    prompt: Prompt | undefined,
    signal?: AbortSignal,
    executor?: AssistantToolExecutor
  ): AsyncGenerator<ChatEvent> {
    const client = await this.createClient();
    const settings = this.getSettings();
    const context = await this.workspaceContext();
    const toolsOn = executor !== undefined && settings.toolsEnabled;

    // The prompt context travels in the user turn (like Thoth); Sobek also
    // appends the derived blocks (plan, parent, workflow, git) to it.
    let promptContent: string | undefined;
    if (prompt) {
      const derived = await buildPromptContext(this.store, prompt);
      promptContent = derived ? `${prompt.content}\n\n${derived}` : prompt.content;
    }

    // @file mentions typed in the chat message travel as inline context.
    let userText = buildChatUserMessage(message, promptContent);
    const mentionPaths = parseMentions(message).map((mention) => mention.raw);
    if (mentionPaths.length > 0) {
      const files = await readSelectedFiles(this.workspaceRoot, mentionPaths);
      const block = buildMentionedFilesBlock(files);
      if (block) {
        userText = `${userText}\n\n${block}`;
      }
    }

    // History replays as plain text; tool intermediates from past turns are
    // not resent — the model re-reads live state through the read tools.
    const contents: GeminiContent[] = [
      ...history.map(
        (turn): GeminiContent => ({ role: turn.role, parts: [{ text: turn.text }] })
      ),
      { role: "user", parts: [{ text: userText }] },
    ];
    const systemInstruction = buildChatSystemInstruction(
      [context, toolsOn ? buildToolGuidanceBlock() : undefined].filter(Boolean).join("\n\n") ||
        undefined
    );

    const events = runToolLoop({
      contents,
      signal,
      request: (loopContents, withTools) =>
        client.stream({
          model: settings.model,
          systemInstruction,
          messages: loopContents,
          tools: withTools && toolsOn ? ASSISTANT_TOOLS : undefined,
          temperature: settings.temperature,
          thinking: this.thinkingFor(settings),
          includeThoughts: true,
          signal,
        }),
      execute: (call) =>
        executor
          ? executor.execute(call)
          : Promise.resolve({ error: "Ferramentas desativadas." }),
    });
    for await (const event of events) {
      if (event.type === "text") {
        yield { type: "text", text: event.text, isThought: event.isThought };
      } else if (event.type === "toolStart") {
        yield { type: "tool", callId: event.callId, name: event.name, status: "running" };
      } else {
        yield {
          type: "tool",
          callId: event.callId,
          name: event.name,
          status: event.ok ? "ok" : "error",
          detail: event.detail,
        };
      }
    }
  }

  listModels() {
    return GEMINI_MODELS;
  }
}
