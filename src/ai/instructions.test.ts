import { describe, expect, it } from "vitest";
import {
  buildChatSystemInstruction,
  buildChatUserMessage,
  buildCustomInstructionsBlock,
  buildDirectoryListing,
  buildToolGuidanceBlock,
  buildGitContextBlock,
  buildLinkedPlanBlock,
  buildMentionedFilesBlock,
  buildParentPromptBlock,
  buildRefineSystemInstruction,
  buildSelectedFilesBlock,
  buildWorkflowStateBlock,
  buildWorkspaceContextBlock,
  CHAT_SYSTEM_INSTRUCTION,
  MAX_DIRECTORY_ENTRIES,
  REFINE_SYSTEM_INSTRUCTION,
  WORKSPACE_CONTEXT_FILES,
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

describe("buildToolGuidanceBlock", () => {
  it("mentions the write tools and full-content refinement", () => {
    const block = buildToolGuidanceBlock();
    expect(block).toContain("## Ferramentas do Sobek");
    expect(block).toContain("update_prompt_content");
    expect(block).toContain("create_child_prompt");
    expect(block).toContain("COMPLETO");
  });

  it("does not alter the verbatim chat instruction", () => {
    expect(buildChatSystemInstruction(undefined)).toBe(CHAT_SYSTEM_INSTRUCTION);
    expect(CHAT_SYSTEM_INSTRUCTION).not.toContain("Ferramentas");
  });
});

describe("buildDirectoryListing", () => {
  it("lists subdirectories first with a trailing slash, then files, alphabetically", () => {
    const listing = buildDirectoryListing([
      { name: "z.ts", isDirectory: false },
      { name: "assets", isDirectory: true },
      { name: "a.ts", isDirectory: false },
      { name: "webview", isDirectory: true },
    ]);
    expect(listing).toBe(
      "(listagem de diretório — 1º nível)\nassets/\nwebview/\na.ts\nz.ts"
    );
  });

  it("caps the listing and reports the omitted count", () => {
    const entries = Array.from({ length: MAX_DIRECTORY_ENTRIES + 5 }, (_, index) => ({
      name: `file-${String(index).padStart(4, "0")}.ts`,
      isDirectory: false,
    }));
    const lines = buildDirectoryListing(entries).split("\n");
    expect(lines).toHaveLength(MAX_DIRECTORY_ENTRIES + 2);
    expect(lines.at(-1)).toBe("… (+5 entradas omitidas)");
  });

  it("renders only the header for an empty directory", () => {
    expect(buildDirectoryListing([])).toBe("(listagem de diretório — 1º nível)");
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

describe("context blocks", () => {
  it("extends the workspace context file list with agent conventions", () => {
    expect(WORKSPACE_CONTEXT_FILES).toEqual([
      "README.md",
      "CLAUDE.md",
      "AGENT.md",
      "AGENTS.md",
      "GEMINI.md",
      ".github/copilot-instructions.md",
    ]);
  });

  it("renders selected files with Thoth's header", () => {
    const block = buildSelectedFilesBlock([{ name: "src/a.ts", content: "code" }]);
    expect(block).toContain("## Arquivos de contexto selecionados");
    expect(block).toContain("### src/a.ts\n\ncode");
    expect(buildSelectedFilesBlock([])).toBeUndefined();
  });

  it("renders custom instructions with Thoth's preamble", () => {
    expect(buildCustomInstructionsBlock("seja curto")).toBe(
      "## Instruções adicionais do usuário\n\nAo refinar, siga estas instruções:\nseja curto"
    );
    expect(buildCustomInstructionsBlock("   ")).toBeUndefined();
  });

  it("renders mentioned files, linked plan and parent prompt blocks", () => {
    expect(buildMentionedFilesBlock([{ name: "src/x.ts", content: "y" }])).toContain(
      "## Arquivos mencionados"
    );
    expect(buildLinkedPlanBlock("plano.md", "# Plano")).toBe(
      "## Plano vinculado (plano.md)\n\n# Plano"
    );
    expect(buildLinkedPlanBlock("plano.md", "  ")).toBeUndefined();
    expect(buildParentPromptBlock("# Pai")).toContain("## Prompt pai");
  });

  it("renders workflow state with notes and iteration", () => {
    const block = buildWorkflowStateBlock({
      phaseName: "Implementação",
      actorLabel: "Codex",
      status: "Active",
      iteration: 2,
      recentNotes: ["nota 1"],
    });
    expect(block).toContain("- Fase atual: Implementação");
    expect(block).toContain("- Responsável atual: Codex");
    expect(block).toContain("- Iteração da fase: 2");
    expect(block).toContain("  - nota 1");
  });

  it("renders git context with branch and commits", () => {
    const block = buildGitContextBlock("main", ["abc123 feat: x"]);
    expect(block).toContain("Branch atual: main");
    expect(block).toContain("abc123 feat: x");
    expect(buildGitContextBlock("", [])).toBeUndefined();
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
