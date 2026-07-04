import { describe, expect, it } from "vitest";
import {
  addNote,
  addReviewVerdict,
  advanceForGeneratedChild,
  advancePhase,
  changeActor,
  completeWorkflow,
  DEFAULT_PHASE_TEMPLATE,
  defaultPhaseTemplateForLocale,
  editPhases,
  findPhaseByRole,
  reopenWorkflow,
  resolveRoleByName,
  setPhase,
  startWorkflow,
} from "./workflow";

const NOW = "2026-07-04T12:00:00.000Z";
const LATER = "2026-07-04T13:00:00.000Z";

describe("startWorkflow", () => {
  it("starts active on 'Engenharia de prompt' with a human actor", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    expect(workflow.status).toBe("Active");
    expect(workflow.currentPhaseName).toBe("Engenharia de prompt");
    expect(workflow.currentActor).toBe("Human");
    expect(workflow.currentPhaseIteration).toBe(1);
    expect(workflow.phases).toHaveLength(10);
    expect(workflow.events).toEqual([
      expect.objectContaining({ type: "WorkflowStarted", phaseName: "Engenharia de prompt" }),
    ]);
  });
});

describe("phase transitions", () => {
  it("advances by order index and records PhaseChanged", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    advancePhase(workflow, LATER);
    expect(workflow.currentPhaseName).toBe("Planejamento");
    expect(workflow.currentActor).toBe("ClaudeCode");
    expect(workflow.events.at(-1)).toMatchObject({ type: "PhaseChanged", phaseName: "Planejamento" });
  });

  it("completes when advancing past the last phase without changing it", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    const merge = findPhaseByRole(workflow, "Merge");
    setPhase(workflow, merge!.id, NOW);
    advancePhase(workflow, LATER);
    expect(workflow.status).toBe("Done");
    expect(workflow.currentPhaseName).toBe("Commit/Merge");
    expect(workflow.events.at(-1)).toMatchObject({ type: "Completed" });
  });

  it("rejects mutations while done, then reopens into a chosen phase", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    completeWorkflow(workflow, NOW);
    expect(() => advancePhase(workflow, LATER)).toThrow();
    const implementation = findPhaseByRole(workflow, "Implementation");
    reopenWorkflow(workflow, LATER, implementation!.id);
    expect(workflow.status).toBe("Active");
    expect(workflow.currentPhaseName).toBe("Implementação");
    expect(workflow.events.at(-1)).toMatchObject({ type: "Reopened" });
  });

  it("changes actor and appends notes without touching the phase", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    changeActor(workflow, "Grok", LATER);
    addNote(workflow, "observação", LATER);
    expect(workflow.currentActor).toBe("Grok");
    expect(workflow.currentPhaseName).toBe("Engenharia de prompt");
    expect(workflow.events.map((event) => event.type)).toEqual([
      "WorkflowStarted",
      "ActorChanged",
      "Note",
    ]);
  });
});

describe("review verdicts", () => {
  it("moves PlanReview to Correção do plano and remembers the source phase", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    const review = findPhaseByRole(workflow, "PlanReview");
    setPhase(workflow, review!.id, NOW);
    addReviewVerdict(workflow, "Plano reprovado: falta migração", LATER);
    expect(workflow.currentPhaseName).toBe("Correção do plano");
    expect(workflow.reviewVerdictSourcePhaseName).toBe("Revisão do plano");
    const types = workflow.events.slice(-2).map((event) => event.type);
    expect(types).toEqual(["Note", "PhaseChanged"]);
  });

  it("rejects verdicts outside review phases", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    expect(() => addReviewVerdict(workflow, "veredito", LATER)).toThrow();
  });
});

describe("automatic advance from generated child prompts", () => {
  it("enters the target phase with the 'Gerado via' note", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    const advanced = advanceForGeneratedChild(workflow, "PlanReview", "Revisar plano", LATER);
    expect(advanced).toBe(true);
    expect(workflow.currentPhaseName).toBe("Revisão do plano");
    expect(workflow.currentPhaseIteration).toBe(1);
    expect(workflow.events.at(-1)?.note).toBe('Gerado via "Revisar plano"');
  });

  it("increments the iteration on re-review", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    advanceForGeneratedChild(workflow, "PlanReview", "Revisar plano", LATER);
    advanceForGeneratedChild(workflow, "PlanReview", "Re-review do plano", LATER);
    expect(workflow.currentPhaseIteration).toBe(2);
    expect(workflow.events.at(-1)?.note).toBe('Re-review #2 - Gerado via "Re-review do plano"');
  });

  it("does nothing when the snapshot lacks the target phase or workflow is done", () => {
    const workflow = startWorkflow(
      DEFAULT_PHASE_TEMPLATE.filter((phase) => phase.role !== "PlanReview"),
      NOW
    );
    expect(advanceForGeneratedChild(workflow, "PlanReview", "Revisar plano", LATER)).toBe(false);
    completeWorkflow(workflow, LATER);
    expect(advanceForGeneratedChild(workflow, "Implementation", "Implementar plano", LATER)).toBe(false);
  });
});

describe("phase snapshot edits", () => {
  it("cannot remove the current phase or phases with history", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    const remaining = workflow.phases
      .filter((phase) => phase.id !== workflow.currentPhaseId)
      .map((phase) => ({
        id: phase.id,
        name: phase.name,
        defaultActor: phase.defaultActor,
        orderIndex: phase.orderIndex,
        color: phase.color,
      }));
    expect(() => editPhases(workflow, remaining, LATER)).toThrow(/current phase/i);
  });

  it("re-derives roles from names and records PhasesEdited", () => {
    const workflow = startWorkflow(DEFAULT_PHASE_TEMPLATE, NOW);
    const inputs = workflow.phases.map((phase) => ({
      id: phase.id,
      name: phase.name === "Teste prático" ? "Revisão de código" : phase.name,
      defaultActor: phase.defaultActor,
      orderIndex: phase.orderIndex,
      color: phase.color,
    }));
    editPhases(workflow, inputs, LATER);
    const renamed = workflow.phases.find((phase) => phase.orderIndex === 7);
    expect(renamed?.role).toBe("CodeReview");
    expect(workflow.events.at(-1)).toMatchObject({ type: "PhasesEdited" });
  });
});

describe("role resolution by name", () => {
  it("normalizes accents and casing", () => {
    expect(resolveRoleByName("revisao do plano")).toBe("PlanReview");
    expect(resolveRoleByName("IMPLEMENTAÇÃO")).toBe("Implementation");
    expect(resolveRoleByName("fase inventada")).toBeUndefined();
  });

  it("recognizes the English default names too", () => {
    expect(resolveRoleByName("Plan review")).toBe("PlanReview");
    expect(resolveRoleByName("update branch with main")).toBe("Rebase");
  });
});

describe("localized default template", () => {
  it("keeps Portuguese for pt locales and English otherwise", () => {
    expect(defaultPhaseTemplateForLocale("pt-br")[0].name).toBe("Engenharia de prompt");
    expect(defaultPhaseTemplateForLocale("pt-PT")[0].name).toBe("Engenharia de prompt");
    expect(defaultPhaseTemplateForLocale("en")[0].name).toBe("Prompt engineering");
    expect(defaultPhaseTemplateForLocale(undefined)[0].name).toBe("Prompt engineering");
  });

  it("preserves roles, actors and colors across languages", () => {
    const pt = defaultPhaseTemplateForLocale("pt-br");
    const en = defaultPhaseTemplateForLocale("en");
    expect(en.map((phase) => phase.role)).toEqual(pt.map((phase) => phase.role));
    expect(en.map((phase) => phase.color)).toEqual(pt.map((phase) => phase.color));
    expect(en.map((phase) => phase.defaultActor)).toEqual(pt.map((phase) => phase.defaultActor));
  });
});
