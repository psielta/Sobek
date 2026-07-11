import { describe, expect, it } from "vitest";
import type { GeminiContent, GeminiStreamChunk } from "./gemini-client";
import { runToolLoop, type ToolLoopEvent } from "./tool-loop";

async function* chunks(...items: GeminiStreamChunk[]): AsyncGenerator<GeminiStreamChunk> {
  for (const item of items) {
    yield item;
  }
}

const text = (value: string, isThought = false): GeminiStreamChunk => ({
  text: value,
  isThought,
});

const call = (name: string, args: Record<string, unknown> = {}, sig?: string): GeminiStreamChunk => ({
  text: "",
  isThought: false,
  functionCall: { name, args },
  thoughtSignature: sig,
});

async function collect(generator: AsyncGenerator<ToolLoopEvent>): Promise<ToolLoopEvent[]> {
  const events: ToolLoopEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

const START: GeminiContent[] = [{ role: "user", parts: [{ text: "oi" }] }];

describe("runToolLoop", () => {
  it("passes through text when the model makes no calls", async () => {
    const events = await collect(
      runToolLoop({
        contents: START,
        request: () => chunks(text("pensando...", true), text("olá "), text("mundo")),
        execute: async () => ({}),
      })
    );
    expect(events).toEqual([
      { type: "text", text: "pensando...", isThought: true },
      { type: "text", text: "olá ", isThought: false },
      { type: "text", text: "mundo", isThought: false },
    ]);
  });

  it("executes a call, appends contents and runs a second pass", async () => {
    const seen: Array<{ length: number; withTools: boolean }> = [];
    let pass = 0;
    const events = await collect(
      runToolLoop({
        contents: START,
        request: (contents, withTools) => {
          seen.push({ length: contents.length, withTools });
          pass++;
          return pass === 1
            ? chunks(call("get_active_prompt", {}, "sig-1"))
            : chunks(text("feito"));
        },
        execute: async (fnCall) => ({ echoed: fnCall.name }),
      })
    );
    expect(events).toEqual([
      { type: "toolStart", callId: 1, name: "get_active_prompt", args: {} },
      { type: "toolEnd", callId: 1, name: "get_active_prompt", ok: true, detail: undefined },
      { type: "text", text: "feito", isThought: false },
    ]);
    // Second pass sees: user + model(functionCall) + user(functionResponse).
    expect(seen).toEqual([
      { length: 1, withTools: true },
      { length: 3, withTools: true },
    ]);
  });

  it("echoes thought signatures on the replayed model turn", async () => {
    let secondPassContents: GeminiContent[] = [];
    let pass = 0;
    await collect(
      runToolLoop({
        contents: START,
        request: (contents) => {
          pass++;
          if (pass === 2) {
            secondPassContents = contents;
          }
          return pass === 1 ? chunks(call("get_prompt", { prompt_id: "1" }, "sig-x")) : chunks(text("ok"));
        },
        execute: async () => ({}),
      })
    );
    const modelTurn = secondPassContents[1];
    expect(modelTurn.role).toBe("model");
    expect(modelTurn.parts[0]).toMatchObject({
      functionCall: { name: "get_prompt" },
      thoughtSignature: "sig-x",
    });
    const responseTurn = secondPassContents[2];
    expect(responseTurn.role).toBe("user");
    expect(responseTurn.parts[0]).toHaveProperty("functionResponse");
  });

  it("reports execute errors as ok:false and keeps looping", async () => {
    let pass = 0;
    const events = await collect(
      runToolLoop({
        contents: START,
        request: () => {
          pass++;
          return pass === 1 ? chunks(call("update_prompt_title", {})) : chunks(text("desculpe"));
        },
        execute: async () => ({ error: "título vazio" }),
      })
    );
    expect(events).toContainEqual({
      type: "toolEnd",
      callId: 1,
      name: "update_prompt_title",
      ok: false,
      detail: "título vazio",
    });
    expect(events.at(-1)).toEqual({ type: "text", text: "desculpe", isThought: false });
  });

  it("bundles parallel calls into one functionResponse content", async () => {
    let secondPassContents: GeminiContent[] = [];
    let pass = 0;
    await collect(
      runToolLoop({
        contents: START,
        request: (contents) => {
          pass++;
          if (pass === 2) {
            secondPassContents = contents;
          }
          return pass === 1
            ? chunks(call("list_prompts"), call("list_templates"))
            : chunks(text("ok"));
        },
        execute: async () => ({}),
      })
    );
    expect(secondPassContents).toHaveLength(3);
    expect(secondPassContents[2].parts).toHaveLength(2);
  });

  it("caps iterations: pending calls get an error and a text-only pass runs", async () => {
    const toolFlags: boolean[] = [];
    const events = await collect(
      runToolLoop({
        contents: START,
        maxIterations: 2,
        request: (_contents, withTools) => {
          toolFlags.push(withTools);
          return withTools ? chunks(call("list_prompts")) : chunks(text("resumo final"));
        },
        execute: async () => ({}),
      })
    );
    // Passes: with tools (call), with tools (call, last iteration), forced text-only.
    expect(toolFlags).toEqual([true, true, false]);
    const lastToolEnd = events.filter((event) => event.type === "toolEnd").at(-1)!;
    expect(lastToolEnd).toMatchObject({ ok: false, detail: expect.stringContaining("Limite") });
    expect(events.at(-1)).toEqual({ type: "text", text: "resumo final", isThought: false });
  });

  it("aborts between tool executions", async () => {
    const controller = new AbortController();
    const generator = runToolLoop({
      contents: START,
      signal: controller.signal,
      request: () => chunks(call("list_prompts")),
      execute: async () => ({}),
    });
    controller.abort();
    await expect(collect(generator)).rejects.toThrow(/aborted/i);
  });
});
