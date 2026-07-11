/**
 * Pure request→execute→functionResponse loop for Gemini function calling.
 * The model request and the tool executor are injected, so this module stays
 * free of vscode/fetch and fully unit-testable.
 */

import type {
  GeminiContent,
  GeminiFunctionCall,
  GeminiPart,
  GeminiStreamChunk,
} from "./gemini-client";
import { MAX_TOOL_LOOP_ITERATIONS } from "./tool-declarations";

export type ToolLoopEvent =
  | { type: "text"; text: string; isThought: boolean }
  | { type: "toolStart"; callId: number; name: string; args: Record<string, unknown> }
  | { type: "toolEnd"; callId: number; name: string; ok: boolean; detail?: string };

export interface ToolLoopOptions {
  /** One streaming model request; `withTools=false` on the forced final pass. */
  request: (contents: GeminiContent[], withTools: boolean) => AsyncGenerator<GeminiStreamChunk>;
  /** Executes one tool call; must never throw — failures return `{ error }`. */
  execute: (call: GeminiFunctionCall) => Promise<Record<string, unknown>>;
  contents: GeminiContent[];
  maxIterations?: number;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

export async function* runToolLoop(options: ToolLoopOptions): AsyncGenerator<ToolLoopEvent> {
  const maxIterations = options.maxIterations ?? MAX_TOOL_LOOP_ITERATIONS;
  const contents = [...options.contents];
  let callId = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Replay the model turn faithfully: Gemini 3 models reject follow-ups
    // whose function calls are missing their thought signatures.
    const modelParts: GeminiPart[] = [];
    const calls: Array<{ call: GeminiFunctionCall; thoughtSignature?: string }> = [];

    for await (const chunk of options.request(contents, true)) {
      if (chunk.functionCall) {
        calls.push({ call: chunk.functionCall, thoughtSignature: chunk.thoughtSignature });
        modelParts.push({
          functionCall: chunk.functionCall,
          thoughtSignature: chunk.thoughtSignature,
        });
      } else if (chunk.text) {
        yield { type: "text", text: chunk.text, isThought: chunk.isThought };
        if (!chunk.isThought) {
          modelParts.push({ text: chunk.text, thoughtSignature: chunk.thoughtSignature });
        }
      }
    }

    if (calls.length === 0) {
      return;
    }

    contents.push({ role: "model", parts: modelParts });

    const isLastIteration = iteration === maxIterations - 1;
    const responseParts: GeminiPart[] = [];
    for (const { call } of calls) {
      throwIfAborted(options.signal);
      const id = ++callId;
      yield { type: "toolStart", callId: id, name: call.name, args: call.args };
      const response = isLastIteration
        ? {
            error:
              "Limite de chamadas de ferramentas atingido nesta mensagem; responda com o que você já tem.",
          }
        : await options.execute(call);
      const ok = !("error" in response);
      yield {
        type: "toolEnd",
        callId: id,
        name: call.name,
        ok,
        detail: ok ? undefined : String(response.error),
      };
      responseParts.push({ functionResponse: { name: call.name, response } });
    }
    contents.push({ role: "user", parts: responseParts });

    if (isLastIteration) {
      // Forced text-only final pass so the conversation always ends in prose.
      for await (const chunk of options.request(contents, false)) {
        if (chunk.text) {
          yield { type: "text", text: chunk.text, isThought: chunk.isThought };
        }
      }
      return;
    }
  }
}
