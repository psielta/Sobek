/**
 * Workflow domain ported from Thoth (`backend/src/Thoth.Domain/Workflows/`).
 *
 * One root prompt = one task = one workflow. Each task owns a snapshot of the
 * phase template taken when the workflow starts, a current actor, a phase
 * iteration counter and an append-only timeline. Child prompts never own a
 * workflow — they trigger automatic phase advances on the parent's workflow.
 */

import { newId } from "../lib/ids";

export type WorkflowStatus = "Active" | "Done";

export type WorkflowActor = "ClaudeCode" | "Codex" | "Human" | "Grok";

export const WORKFLOW_ACTOR_LABELS: Record<WorkflowActor, string> = {
  ClaudeCode: "Claude",
  Codex: "Codex",
  Human: "Você",
  Grok: "Grok",
};

export type WorkflowPhaseRole =
  | "PromptEngineering"
  | "Planning"
  | "PlanReview"
  | "PlanCorrection"
  | "Implementation"
  | "CodeReview"
  | "ReviewCorrection"
  | "PracticalTest"
  | "Rebase"
  | "Merge";

export type WorkflowEventType =
  | "WorkflowStarted"
  | "PhaseChanged"
  | "ActorChanged"
  | "Note"
  | "Completed"
  | "Reopened"
  | "PhasesEdited";

export const WORKFLOW_EVENT_LABELS: Record<WorkflowEventType, string> = {
  WorkflowStarted: "Fluxo iniciado",
  PhaseChanged: "Mudou de fase",
  ActorChanged: "Trocou responsável",
  Note: "Nota",
  Completed: "Concluída",
  Reopened: "Reaberta",
  PhasesEdited: "Fases editadas",
};

export interface WorkflowPhase {
  id: string;
  name: string;
  defaultActor: WorkflowActor;
  orderIndex: number;
  color: string;
  role?: WorkflowPhaseRole;
}

export interface WorkflowEvent {
  id: string;
  type: WorkflowEventType;
  phaseId?: string;
  phaseName?: string;
  actor?: WorkflowActor;
  note?: string;
  occurredAt: string;
}

export interface Workflow {
  status: WorkflowStatus;
  currentPhaseId?: string;
  currentPhaseName?: string;
  currentPhaseColor?: string;
  currentActor?: WorkflowActor;
  currentPhaseIteration: number;
  reviewVerdictSourcePhaseName?: string;
  startedAt: string;
  enteredCurrentPhaseAt?: string;
  phases: WorkflowPhase[];
  events: WorkflowEvent[];
}

/** Phase template definition (no ids yet). */
export interface PhaseTemplate {
  name: string;
  defaultActor: WorkflowActor;
  orderIndex: number;
  color: string;
  role?: WorkflowPhaseRole;
}

/** Thoth's "Fluxo padrão" template, values verbatim from WorkflowDefaults.cs. */
export const DEFAULT_PHASE_TEMPLATE: PhaseTemplate[] = [
  { name: "Engenharia de prompt", defaultActor: "Human", orderIndex: 0, color: "#9333ea", role: "PromptEngineering" },
  { name: "Planejamento", defaultActor: "ClaudeCode", orderIndex: 1, color: "#2563eb", role: "Planning" },
  { name: "Revisão do plano", defaultActor: "Codex", orderIndex: 2, color: "#7c3aed", role: "PlanReview" },
  { name: "Correção do plano", defaultActor: "ClaudeCode", orderIndex: 3, color: "#d97706", role: "PlanCorrection" },
  { name: "Implementação", defaultActor: "Codex", orderIndex: 4, color: "#0d9488", role: "Implementation" },
  { name: "Revisão de código", defaultActor: "ClaudeCode", orderIndex: 5, color: "#0891b2", role: "CodeReview" },
  { name: "Correção da revisão", defaultActor: "Codex", orderIndex: 6, color: "#dc2626", role: "ReviewCorrection" },
  { name: "Teste prático", defaultActor: "Human", orderIndex: 7, color: "#db2777", role: "PracticalTest" },
  { name: "Atualizar branch com main", defaultActor: "Codex", orderIndex: 8, color: "#15803d", role: "Rebase" },
  { name: "Commit/Merge", defaultActor: "Codex", orderIndex: 9, color: "#16a34a", role: "Merge" },
];

/** English phase names for non-Portuguese VS Code display languages. */
const PHASE_NAME_EN: Record<WorkflowPhaseRole, string> = {
  PromptEngineering: "Prompt engineering",
  Planning: "Planning",
  PlanReview: "Plan review",
  PlanCorrection: "Plan correction",
  Implementation: "Implementation",
  CodeReview: "Code review",
  ReviewCorrection: "Review correction",
  PracticalTest: "Practical test",
  Rebase: "Update branch with main",
  Merge: "Commit/Merge",
};

export const DEFAULT_PHASE_TEMPLATE_EN: PhaseTemplate[] = DEFAULT_PHASE_TEMPLATE.map((phase) => ({
  ...phase,
  name: PHASE_NAME_EN[phase.role as WorkflowPhaseRole],
}));

/**
 * Default template in the editor's display language. Phase names are DATA
 * (snapshotted per task), so this only affects newly created templates;
 * existing tasks keep their snapshot, like Thoth.
 */
export function defaultPhaseTemplateForLocale(language: string | undefined): PhaseTemplate[] {
  return language?.toLowerCase().startsWith("pt")
    ? DEFAULT_PHASE_TEMPLATE
    : DEFAULT_PHASE_TEMPLATE_EN;
}

export const PHASE_COLOR_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#d97706",
  "#0d9488",
  "#0891b2",
  "#db2777",
  "#16a34a",
  "#15803d",
  "#9333ea",
  "#dc2626",
];

/** Normalizes accents/casing the same way WorkflowDefaults.ResolveRoleByName does. */
function normalizePhaseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

const ROLE_BY_NORMALIZED_NAME = new Map<string, WorkflowPhaseRole>(
  [...DEFAULT_PHASE_TEMPLATE, ...DEFAULT_PHASE_TEMPLATE_EN].map((phase) => [
    normalizePhaseName(phase.name),
    phase.role as WorkflowPhaseRole,
  ])
);

export function resolveRoleByName(name: string): WorkflowPhaseRole | undefined {
  return ROLE_BY_NORMALIZED_NAME.get(normalizePhaseName(name));
}

/** Review phase → correction phase targeted by a review verdict. */
export const CORRECTION_ROLE_BY_REVIEW_ROLE: Partial<Record<WorkflowPhaseRole, WorkflowPhaseRole>> = {
  PlanReview: "PlanCorrection",
  CodeReview: "ReviewCorrection",
};

export function instantiatePhases(template: PhaseTemplate[]): WorkflowPhase[] {
  return [...template]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((phase, index) => ({
      id: newId(),
      name: phase.name,
      defaultActor: phase.defaultActor,
      orderIndex: index,
      color: phase.color,
      role: phase.role ?? resolveRoleByName(phase.name),
    }));
}

function appendEvent(
  workflow: Workflow,
  type: WorkflowEventType,
  details: { phase?: WorkflowPhase; actor?: WorkflowActor; note?: string; now: string }
): void {
  workflow.events.push({
    id: newId(),
    type,
    phaseId: details.phase?.id,
    phaseName: details.phase?.name,
    actor: details.actor,
    note: details.note,
    occurredAt: details.now,
  });
}

function enterPhase(workflow: Workflow, phase: WorkflowPhase, actor: WorkflowActor | undefined, now: string): void {
  workflow.currentPhaseId = phase.id;
  workflow.currentPhaseName = phase.name;
  workflow.currentPhaseColor = phase.color;
  workflow.currentActor = actor ?? phase.defaultActor;
  workflow.enteredCurrentPhaseAt = now;
  workflow.currentPhaseIteration = 1;
  workflow.reviewVerdictSourcePhaseName = undefined;
}

export function startWorkflow(
  template: PhaseTemplate[],
  now: string,
  initialPhaseOrderIndex = 0
): Workflow {
  const phases = instantiatePhases(template);
  const initial = phases.find((phase) => phase.orderIndex === initialPhaseOrderIndex) ?? phases[0];
  if (!initial) {
    throw new Error("Workflow template must contain at least one phase.");
  }
  const workflow: Workflow = {
    status: "Active",
    currentPhaseIteration: 1,
    startedAt: now,
    phases,
    events: [],
  };
  enterPhase(workflow, initial, undefined, now);
  appendEvent(workflow, "WorkflowStarted", { phase: initial, actor: workflow.currentActor, now });
  return workflow;
}

function ensureActive(workflow: Workflow): void {
  if (workflow.status !== "Active") {
    throw new Error("Workflow is not active.");
  }
}

export function findPhase(workflow: Workflow, phaseId: string): WorkflowPhase {
  const phase = workflow.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) {
    throw new Error("Phase not found in this task's snapshot.");
  }
  return phase;
}

export function findPhaseByRole(workflow: Workflow, role: WorkflowPhaseRole): WorkflowPhase | undefined {
  return [...workflow.phases]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .find((phase) => phase.role === role);
}

/** Advance to the next phase by order index; completes when on the last phase. */
export function advancePhase(workflow: Workflow, now: string, note?: string): void {
  ensureActive(workflow);
  const ordered = [...workflow.phases].sort((a, b) => a.orderIndex - b.orderIndex);
  const currentIndex = ordered.findIndex((phase) => phase.id === workflow.currentPhaseId);
  const next = ordered[currentIndex + 1];
  if (!next) {
    completeWorkflow(workflow, now, note);
    return;
  }
  enterPhase(workflow, next, undefined, now);
  appendEvent(workflow, "PhaseChanged", { phase: next, actor: workflow.currentActor, note, now });
}

export function setPhase(
  workflow: Workflow,
  phaseId: string,
  now: string,
  actor?: WorkflowActor,
  note?: string
): void {
  ensureActive(workflow);
  const phase = findPhase(workflow, phaseId);
  enterPhase(workflow, phase, actor, now);
  appendEvent(workflow, "PhaseChanged", { phase, actor: workflow.currentActor, note, now });
}

export function changeActor(workflow: Workflow, actor: WorkflowActor, now: string, note?: string): void {
  ensureActive(workflow);
  workflow.currentActor = actor;
  appendEvent(workflow, "ActorChanged", {
    phase: workflow.currentPhaseId ? findPhase(workflow, workflow.currentPhaseId) : undefined,
    actor,
    note,
    now,
  });
}

export function addNote(workflow: Workflow, note: string, now: string): void {
  ensureActive(workflow);
  appendEvent(workflow, "Note", {
    phase: workflow.currentPhaseId ? findPhase(workflow, workflow.currentPhaseId) : undefined,
    actor: workflow.currentActor,
    note,
    now,
  });
}

/**
 * Records a review verdict as a note anchored on the current review phase and
 * moves the task to the matching correction phase, remembering the source.
 */
export function addReviewVerdict(workflow: Workflow, verdict: string, now: string): void {
  ensureActive(workflow);
  if (!workflow.currentPhaseId) {
    throw new Error("Workflow has no current phase.");
  }
  const reviewPhase = findPhase(workflow, workflow.currentPhaseId);
  const reviewRole = reviewPhase.role;
  const correctionRole = reviewRole ? CORRECTION_ROLE_BY_REVIEW_ROLE[reviewRole] : undefined;
  if (!correctionRole) {
    throw new Error("Review verdicts are only available on review phases.");
  }
  const correctionPhase = findPhaseByRole(workflow, correctionRole);
  if (!correctionPhase) {
    throw new Error("This task's snapshot has no matching correction phase.");
  }
  appendEvent(workflow, "Note", { phase: reviewPhase, actor: workflow.currentActor, note: verdict, now });
  enterPhase(workflow, correctionPhase, undefined, now);
  workflow.reviewVerdictSourcePhaseName = reviewPhase.name;
  appendEvent(workflow, "PhaseChanged", { phase: correctionPhase, actor: workflow.currentActor, now });
}

/** Completing never changes the phase and never archives the prompt. */
export function completeWorkflow(workflow: Workflow, now: string, note?: string): void {
  ensureActive(workflow);
  workflow.status = "Done";
  appendEvent(workflow, "Completed", {
    phase: workflow.currentPhaseId ? findPhase(workflow, workflow.currentPhaseId) : undefined,
    actor: workflow.currentActor,
    note,
    now,
  });
}

export function reopenWorkflow(workflow: Workflow, now: string, phaseId?: string): void {
  if (workflow.status !== "Done") {
    throw new Error("Only completed workflows can be reopened.");
  }
  workflow.status = "Active";
  if (phaseId) {
    const phase = findPhase(workflow, phaseId);
    enterPhase(workflow, phase, undefined, now);
  }
  appendEvent(workflow, "Reopened", {
    phase: workflow.currentPhaseId ? findPhase(workflow, workflow.currentPhaseId) : undefined,
    actor: workflow.currentActor,
    now,
  });
}

const GENERATED_NOTE_PREFIX = "Gerado via ";
const RE_REVIEW_NOTE_PREFIX = "Re-review #";

/**
 * Automatic advance triggered when a child prompt is generated from a template
 * that targets a phase role. Mirrors CreatePromptHandler.TryAdvanceParentWorkflow:
 * counts prior template-generated entries into the target phase to derive the
 * iteration and stamps the note accordingly.
 */
export function advanceForGeneratedChild(
  workflow: Workflow,
  targetRole: WorkflowPhaseRole,
  templateDisplayName: string,
  now: string
): boolean {
  if (workflow.status !== "Active") {
    return false;
  }
  const target = findPhaseByRole(workflow, targetRole);
  if (!target) {
    return false;
  }
  const prior = workflow.events.filter(
    (event) =>
      event.type === "PhaseChanged" &&
      event.phaseId === target.id &&
      (event.note?.startsWith(GENERATED_NOTE_PREFIX) || event.note?.startsWith(RE_REVIEW_NOTE_PREFIX))
  ).length;
  const iteration = prior + 1;
  const note =
    iteration > 1
      ? `${RE_REVIEW_NOTE_PREFIX}${iteration} - ${GENERATED_NOTE_PREFIX}"${templateDisplayName}"`
      : `${GENERATED_NOTE_PREFIX}"${templateDisplayName}"`;
  enterPhase(workflow, target, undefined, now);
  workflow.currentPhaseIteration = iteration;
  appendEvent(workflow, "PhaseChanged", { phase: target, actor: workflow.currentActor, note, now });
  return true;
}

export interface PhaseEditInput {
  id?: string;
  name: string;
  defaultActor: WorkflowActor;
  orderIndex: number;
  color: string;
}

/**
 * Edits a task's phase snapshot. The current phase and phases already
 * referenced by timeline events cannot be removed.
 */
export function editPhases(workflow: Workflow, inputs: PhaseEditInput[], now: string): void {
  ensureActive(workflow);
  const keptIds = new Set(inputs.filter((input) => input.id).map((input) => input.id as string));
  for (const phase of workflow.phases) {
    if (keptIds.has(phase.id)) {
      continue;
    }
    if (phase.id === workflow.currentPhaseId) {
      throw new Error("The current phase cannot be removed.");
    }
    if (workflow.events.some((event) => event.phaseId === phase.id)) {
      throw new Error(`Phase "${phase.name}" has timeline history and cannot be removed.`);
    }
  }

  const byId = new Map(workflow.phases.map((phase) => [phase.id, phase]));
  workflow.phases = [...inputs]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((input, index) => {
      const existing = input.id ? byId.get(input.id) : undefined;
      return {
        id: existing?.id ?? newId(),
        name: input.name,
        defaultActor: input.defaultActor,
        orderIndex: index,
        color: input.color,
        role: resolveRoleByName(input.name),
      };
    });

  if (workflow.currentPhaseId) {
    const current = workflow.phases.find((phase) => phase.id === workflow.currentPhaseId);
    if (current) {
      workflow.currentPhaseName = current.name;
      workflow.currentPhaseColor = current.color;
    }
  }
  appendEvent(workflow, "PhasesEdited", { actor: workflow.currentActor, now });
}
