/**
 * Minimal Gemini API client for the extension host.
 *
 * Uses the REST endpoints of the Google Generative Language API directly so
 * the extension carries no SDK dependency. The API key never leaves the
 * extension host process. Request bodies mirror the ones Thoth's backend
 * builds in `GeminiApiClient.BuildGenerateBody`.
 */

import type { ThinkingLevel, ThinkingMode } from "./models";

export interface GeminiMessage {
  role: "user" | "model";
  text: string;
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

/** One content part; Gemini 3 thought signatures must be echoed back verbatim. */
export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: GeminiFunctionCall; thoughtSignature?: string }
  | { functionResponse: GeminiFunctionResponse };

/** Full-parts content, used by the tool loop to replay model/function turns. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** OpenAPI-subset schema; type values use the REST enum ("OBJECT", "STRING", ...). */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiThinkingOptions {
  mode: ThinkingMode;
  budget?: number | null;
  level?: ThinkingLevel | null;
}

export interface GeminiRequestOptions {
  model: string;
  systemInstruction?: string;
  messages: Array<GeminiMessage | GeminiContent>;
  tools?: GeminiFunctionDeclaration[];
  temperature?: number;
  thinking?: GeminiThinkingOptions;
  /** Whether thought parts should be requested and surfaced (chat only). */
  includeThoughts?: boolean;
  signal?: AbortSignal;
}

export interface GeminiStreamChunk {
  /** Empty string on functionCall chunks. */
  text: string;
  isThought: boolean;
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
}

export interface GeminiClientOptions {
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { name: string; args?: Record<string, unknown> };
        thoughtSignature?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export interface GeminiResult {
  text: string;
  promptTokens: number;
  candidateTokens: number;
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: GeminiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  private buildBody(options: GeminiRequestOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: options.messages.map((message) =>
        "parts" in message
          ? { role: message.role, parts: message.parts }
          : { role: message.role, parts: [{ text: message.text }] }
      ),
    };
    if (options.systemInstruction) {
      body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = [{ functionDeclarations: options.tools }];
    }

    const generationConfig: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }

    const thinking = options.thinking;
    const includeThoughts = options.includeThoughts ?? false;
    if (thinking && thinking.mode === "budget") {
      const budget = thinking.budget ?? 0;
      generationConfig.thinkingConfig = {
        thinkingBudget: budget,
        includeThoughts: includeThoughts && budget > 0,
      };
    } else if (thinking && thinking.mode === "level") {
      generationConfig.thinkingConfig = {
        thinkingLevel: (thinking.level ?? "high").toLowerCase(),
        includeThoughts,
      };
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }
    return body;
  }

  private async post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GeminiApiError(
        `Gemini API request failed (${response.status}): ${detail.slice(0, 500)}`,
        response.status
      );
    }
    return response;
  }

  /** Single-shot completion; returns concatenated non-thought text parts. */
  async generate(options: GeminiRequestOptions): Promise<GeminiResult> {
    const url = `${this.baseUrl}/models/${options.model}:generateContent`;
    const response = await this.post(url, this.buildBody(options), options.signal);
    const payload = (await response.json()) as GenerateContentResponse;
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts
        .filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text)
        .join(""),
      promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      candidateTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  /** Streaming completion over SSE; yields text/thought deltas as they arrive. */
  async *stream(options: GeminiRequestOptions): AsyncGenerator<GeminiStreamChunk> {
    const url = `${this.baseUrl}/models/${options.model}:streamGenerateContent?alt=sse`;
    const response = await this.post(url, this.buildBody(options), options.signal);
    if (!response.body) {
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            continue;
          }
          const chunk = JSON.parse(data) as GenerateContentResponse;
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.functionCall) {
              // Args arrive as a complete JSON object within a single chunk.
              yield {
                text: "",
                isThought: false,
                functionCall: { name: part.functionCall.name, args: part.functionCall.args ?? {} },
                thoughtSignature: part.thoughtSignature,
              };
            } else if (typeof part.text === "string" && part.text.length > 0) {
              yield {
                text: part.text,
                isThought: part.thought === true,
                thoughtSignature: part.thoughtSignature,
              };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
