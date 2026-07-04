import { describe, expect, it } from "vitest";
import { parseCustomTemplate, substitutePlaceholders } from "./custom-templates";
import type { PromptTemplateContext } from "./templates";

const CONTEXT: PromptTemplateContext = {
  absolutePath: "D:\\repo\\docs\\plan.md",
  displayName: "plan.md",
  parentPromptContent: "# Prompt pai",
  pullRequestReference: "PR #7",
  inputs: { escopo: "módulo de pagamentos" },
};

const VALID = `---
name: Revisão de segurança
description: Auditoria focada em segurança
targetAgent: Codex
kind: General
targetPhaseRole: CodeReview
title: "Security review: {DisplayName}"
inputs:
  - key: escopo
    label: Escopo
    placeholder: módulos a auditar
    required: true
    multiline: false
---
Audite o plano "{AbsolutePath}" focando em segurança.

Escopo: {input:escopo}

{ParentPromptContent}
`;

describe("parseCustomTemplate", () => {
  it("parses a full template with inputs", () => {
    const { definition, error } = parseCustomTemplate("security-review", VALID);
    expect(error).toBeUndefined();
    expect(definition!.key).toBe("custom:security-review");
    expect(definition!.displayName).toBe("Revisão de segurança");
    expect(definition!.defaultTargetAgent).toBe("Codex");
    expect(definition!.targetPhaseRole).toBe("CodeReview");
    expect(definition!.requiresPullRequest).toBe(false);
    expect(definition!.inputs).toEqual([
      {
        key: "escopo",
        label: "Escopo",
        placeholder: "módulos a auditar",
        helpText: "",
        required: true,
        multiline: false,
      },
    ]);
  });

  it("renders title and body with placeholders", () => {
    const { definition } = parseCustomTemplate("security-review", VALID);
    const rendered = definition!.render(CONTEXT);
    expect(rendered.title).toBe("Security review: plan.md");
    expect(rendered.content).toContain('Audite o plano "D:\\repo\\docs\\plan.md"');
    expect(rendered.content).toContain("Escopo: módulo de pagamentos");
    expect(rendered.content).toContain("# Prompt pai");
  });

  it("applies defaults and derives requiresPullRequest from the body", () => {
    const { definition } = parseCustomTemplate(
      "merge-check",
      "---\nname: Checar merge\n---\nConfira o {PullRequestReference} do plano {AbsolutePath}."
    );
    expect(definition!.defaultTargetAgent).toBe("ClaudeCode");
    expect(definition!.defaultKind).toBe("General");
    expect(definition!.targetPhaseRole).toBeUndefined();
    expect(definition!.requiresPullRequest).toBe(true);
    expect(definition!.render(CONTEXT).title).toBe("Checar merge: plan.md");
  });

  it("rejects missing frontmatter, empty body and invalid enums", () => {
    expect(parseCustomTemplate("a", "sem frontmatter").error?.message).toMatch(/Frontmatter/);
    expect(parseCustomTemplate("b", "---\nname: X\n---\n").error?.message).toMatch(/vazio/);
    expect(
      parseCustomTemplate("c", "---\nname: X\ntargetAgent: Gemini\n---\ncorpo").error?.message
    ).toMatch(/targetAgent/);
    expect(
      parseCustomTemplate("d", "---\nname: X\ntargetPhaseRole: Nope\n---\ncorpo").error?.message
    ).toMatch(/targetPhaseRole/);
  });

  it("strips inline comments from bare values but keeps quoted ones", () => {
    const { definition } = parseCustomTemplate(
      "comments",
      '---\nname: Teste\ntargetAgent: Codex   # agente\ntitle: "Com # dentro: {DisplayName}"\n---\ncorpo'
    );
    expect(definition!.defaultTargetAgent).toBe("Codex");
    expect(definition!.render(CONTEXT).title).toBe("Com # dentro: plan.md");
  });
});

describe("substitutePlaceholders", () => {
  it("replaces every token and empties unknown inputs", () => {
    expect(
      substitutePlaceholders("{DisplayName}|{PullRequestReference}|{input:nao-existe}", CONTEXT)
    ).toBe("plan.md|PR #7|");
  });
});
