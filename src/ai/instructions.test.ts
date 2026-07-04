import { describe, expect, it } from "vitest";
import {
  buildChatSystemInstruction,
  buildChatUserMessage,
  buildRefineSystemInstruction,
  buildWorkspaceContextBlock,
  CHAT_SYSTEM_INSTRUCTION,
  REFINE_SYSTEM_INSTRUCTION,
} from "./instructions";
import { DEFAULT_AI_SETTINGS, deriveThinkingMode } from "./models";

describe("workspace context block", () => {
  it("returns undefined when there are no context files", () => {
    expect(buildWorkspaceContextBlock([])).toBeUndefined();
  });

  it("renders each file as a section under the workspace header", () => {
    const block = buildWorkspaceContextBlock([
      { name: "README.md", content: "# Projeto" },
      { name: "CLAUDE.md", content: "Regras" },
    ]);
    expect(block).toContain("## Contexto do workspace");
    expect(block).toContain("### README.md\n\n# Projeto");
    expect(block).toContain("### CLAUDE.md\n\nRegras");
  });
});

describe("system instruction composition", () => {
  it("keeps the base refine instruction when no context exists", () => {
    expect(buildRefineSystemInstruction()).toBe(REFINE_SYSTEM_INSTRUCTION);
  });

  it("appends workspace context after a blank line", () => {
    expect(buildRefineSystemInstruction("CTX")).toBe(`${REFINE_SYSTEM_INSTRUCTION}\n\nCTX`);
    expect(buildChatSystemInstruction("CTX")).toBe(`${CHAT_SYSTEM_INSTRUCTION}\n\nCTX`);
  });
});

describe("chat user message", () => {
  it("returns the raw message without prompt context", () => {
    expect(buildChatUserMessage("olá")).toBe("olá");
  });

  it("embeds the current prompt content using Thoth's separator", () => {
    expect(buildChatUserMessage("olá", "# Prompt")).toBe(
      "olá\n\n---\n**Conteúdo do prompt atual:**\n# Prompt"
    );
  });
});

describe("thinking mode derivation", () => {
  it("defaults to level mode with the default settings", () => {
    expect(deriveThinkingMode(DEFAULT_AI_SETTINGS)).toBe("level");
  });

  it("prefers budget over level when both are set", () => {
    expect(
      deriveThinkingMode({ ...DEFAULT_AI_SETTINGS, thinkingBudget: 1024 })
    ).toBe("budget");
  });

  it("returns none when thinking is disabled", () => {
    expect(
      deriveThinkingMode({ ...DEFAULT_AI_SETTINGS, thinkingEnabled: false })
    ).toBe("none");
  });
});
