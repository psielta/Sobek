import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TOOL_NAMES,
  ASSISTANT_TOOLS,
  clampContent,
  MAX_TOOL_CONTENT_CHARS,
  optionalStringArg,
  requireStringArg,
} from "./tool-declarations";

describe("ASSISTANT_TOOLS", () => {
  it("declares unique snake_case names with non-empty descriptions", () => {
    expect(new Set(ASSISTANT_TOOL_NAMES).size).toBe(ASSISTANT_TOOLS.length);
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("uses OBJECT schemas whose required keys exist in properties", () => {
    for (const tool of ASSISTANT_TOOLS) {
      if (!tool.parameters) {
        continue;
      }
      expect(tool.parameters.type).toBe("OBJECT");
      const properties = tool.parameters.properties as Record<string, unknown>;
      expect(properties).toBeDefined();
      const required = (tool.parameters.required as string[] | undefined) ?? [];
      for (const key of required) {
        expect(properties[key], `${tool.name}: required "${key}"`).toBeDefined();
      }
    }
  });

  it("restricts set_prompt_status to Draft/Ready", () => {
    const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === "set_prompt_status")!;
    const properties = tool.parameters?.properties as Record<string, { enum?: string[] }>;
    expect(properties.status.enum).toEqual(["Draft", "Ready"]);
  });

  it("exposes no destructive or terminal tools", () => {
    for (const name of ASSISTANT_TOOL_NAMES) {
      expect(name).not.toMatch(/delete|archive|terminal|run_/);
    }
  });
});

describe("arg helpers", () => {
  it("requireStringArg throws on missing or empty values", () => {
    expect(requireStringArg({ title: "x" }, "title")).toBe("x");
    expect(() => requireStringArg({}, "title")).toThrow(/title/);
    expect(() => requireStringArg({ title: "  " }, "title")).toThrow(/title/);
    expect(() => requireStringArg({ title: 5 }, "title")).toThrow(/title/);
  });

  it("optionalStringArg returns undefined for absent or blank values", () => {
    expect(optionalStringArg({ note: "ok" }, "note")).toBe("ok");
    expect(optionalStringArg({}, "note")).toBeUndefined();
    expect(optionalStringArg({ note: "" }, "note")).toBeUndefined();
  });

  it("clampContent bounds long payloads and flags truncation", () => {
    const short = clampContent("abc");
    expect(short).toEqual({ content: "abc", truncated: false });
    const long = clampContent("x".repeat(MAX_TOOL_CONTENT_CHARS + 10));
    expect(long.content).toHaveLength(MAX_TOOL_CONTENT_CHARS);
    expect(long.truncated).toBe(true);
  });
});
