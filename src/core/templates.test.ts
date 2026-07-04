import { describe, expect, it } from "vitest";
import { formatPullRequestReference } from "./prompt";
import {
  findTemplate,
  getTemplatesInDisplayOrder,
  renderPromptDraft,
  templateRequiresPullRequest,
} from "./templates";

const PLAN = {
  planAbsolutePath: "D:\\repo\\docs\\plan.md",
  planDisplayName: "plan.md",
  parentPromptContent: "# Prompt pai",
};

describe("template catalog", () => {
  it("keeps Thoth's display order", () => {
    expect(getTemplatesInDisplayOrder().map((template) => template.key)).toEqual([
      "ReviewPlan",
      "ImplementPlan",
      "ReviewPlanWithParentPrompt",
      "ReReviewPlan",
      "ImplementPlanInWorktree",
      "ReviewPullRequest",
      "ReReviewPullRequest",
      "RebaseCurrentBranch",
      "MergePullRequest",
    ]);
  });

  it("marks re-review templates and PR requirements", () => {
    expect(findTemplate("ReReviewPlan")?.isReReview).toBe(true);
    expect(findTemplate("ReReviewPullRequest")?.isReReview).toBe(true);
    expect(templateRequiresPullRequest("ReviewPullRequest")).toBe(true);
    expect(templateRequiresPullRequest("MergePullRequest")).toBe(true);
    expect(templateRequiresPullRequest("ReviewPlan")).toBe(false);
  });
});

describe("renderPromptDraft", () => {
  it("renders ReviewPlan with the plan path", () => {
    const draft = renderPromptDraft({ template: findTemplate("ReviewPlan")!, ...PLAN });
    expect(draft.title).toBe("Revisar plano: plan.md");
    expect(draft.content).toBe(
      'Dado o plano "D:\\repo\\docs\\plan.md", valide o plano, aprove-o ou aponte melhorias.'
    );
  });

  it("embeds the parent prompt in ReviewPlanWithParentPrompt", () => {
    const draft = renderPromptDraft({
      template: findTemplate("ReviewPlanWithParentPrompt")!,
      ...PLAN,
    });
    expect(draft.content).toContain("```md\n# Prompt pai\n```");
    expect(draft.content).toContain('Ele gerou o plano "D:\\repo\\docs\\plan.md".');
  });

  it("requires a PR for ReviewPullRequest and formats bare numbers", () => {
    const template = findTemplate("ReviewPullRequest")!;
    expect(() => renderPromptDraft({ template, ...PLAN })).toThrow(/PR/);
    const draft = renderPromptDraft({ template, ...PLAN, pullRequestInput: "123" });
    expect(draft.title).toBe("Revisar PR #123: plan.md");
    expect(draft.content).toContain("/review");
    expect(draft.content).toContain("Revise o PR #123 que implementa o plano `D:\\repo\\docs\\plan.md`.");
  });

  it("falls back to the stored PR reference", () => {
    const draft = renderPromptDraft({
      template: findTemplate("MergePullRequest")!,
      ...PLAN,
      storedPullRequestReference: "#77",
    });
    expect(draft.title).toBe("Mesclar #77: plan.md");
  });

  it("requires the codexResponse input on ReReviewPullRequest", () => {
    const template = findTemplate("ReReviewPullRequest")!;
    expect(() =>
      renderPromptDraft({ template, ...PLAN, pullRequestInput: "#9" })
    ).toThrow(/Resposta do Codex/);
    const draft = renderPromptDraft({
      template,
      ...PLAN,
      pullRequestInput: "#9",
      inputs: { codexResponse: "Corrigi tudo." },
    });
    expect(draft.content).toContain("```md\nCorrigi tudo.\n```");
  });
});

describe("formatPullRequestReference", () => {
  it("passes through #, PR-prefix and URLs; wraps everything else", () => {
    expect(formatPullRequestReference("#123")).toBe("#123");
    expect(formatPullRequestReference("PR 123")).toBe("PR 123");
    expect(formatPullRequestReference("https://github.com/a/b/pull/5")).toBe(
      "https://github.com/a/b/pull/5"
    );
    expect(formatPullRequestReference("123")).toBe("PR #123");
  });
});
