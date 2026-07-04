/**
 * Child prompt templates ported verbatim from Thoth
 * (`backend/src/Thoth.Application/Features/PromptTemplates/Definitions/`).
 *
 * A child prompt is generated from a plan (a Markdown file, typically written
 * by an agent) linked to the parent prompt. Rendering is a pure function of
 * the template context; creating the child afterwards advances the parent's
 * workflow to the template's target phase role.
 */

import { formatPullRequestReference, type PromptKind, type TargetAgent } from "./prompt";
import type { WorkflowPhaseRole } from "./workflow";

export type PromptTemplateKey =
  | "ReviewPlan"
  | "ImplementPlan"
  | "ReviewPlanWithParentPrompt"
  | "ReReviewPlan"
  | "ImplementPlanInWorktree"
  | "ReviewPullRequest"
  | "MergePullRequest"
  | "RebaseCurrentBranch"
  | "ReReviewPullRequest";

export interface PromptTemplateInput {
  key: string;
  label: string;
  placeholder: string;
  helpText: string;
  required: boolean;
  multiline: boolean;
}

export interface PromptTemplateContext {
  /** Absolute path of the linked plan file. */
  absolutePath: string;
  /** Display name of the plan (defaults to the file name). */
  displayName: string;
  /** Markdown content of the parent prompt. */
  parentPromptContent: string;
  /** Resolved pull request reference, already formatted. */
  pullRequestReference?: string;
  /** Raw template inputs keyed by input key. */
  inputs: Record<string, string>;
}

export interface RenderedPromptTemplate {
  title: string;
  content: string;
}

export interface PromptTemplateDefinition {
  /** Built-in PromptTemplateKey or `custom:<slug>` for workspace templates. */
  key: string;
  displayName: string;
  description: string;
  defaultTargetAgent: TargetAgent;
  defaultKind: PromptKind;
  /** Phase the PARENT workflow advances to; absent = no auto-advance. */
  targetPhaseRole?: WorkflowPhaseRole;
  isReReview: boolean;
  /** Requires a PR reference before rendering. */
  requiresPullRequest?: boolean;
  displayOrder: number;
  inputs: PromptTemplateInput[];
  render(context: PromptTemplateContext): RenderedPromptTemplate;
}

const PULL_REQUEST_INPUT = (helpText: string): PromptTemplateInput => ({
  key: "pullRequest",
  label: "PR",
  placeholder: "#123 ou URL da PR",
  helpText,
  required: true,
  multiline: false,
});

const CODEX_RESPONSE_INPUT: PromptTemplateInput = {
  key: "codexResponse",
  label: "Resposta do Codex",
  placeholder: "Cole a resposta do Codex apos corrigir os pontos da primeira revisao",
  helpText: "",
  required: true,
  multiline: true,
};

export const MAX_MULTILINE_INPUT_CHARS = 20_000;

export const PROMPT_TEMPLATES: PromptTemplateDefinition[] = [
  {
    key: "ReviewPlan",
    displayName: "Revisar plano",
    description: "Valida o plano vinculado, aprovando ou apontando melhorias.",
    defaultTargetAgent: "Codex",
    defaultKind: "Planning",
    targetPhaseRole: "PlanReview",
    isReReview: false,
    displayOrder: 10,
    inputs: [],
    render: (context) => ({
      title: `Revisar plano: ${context.displayName}`,
      content: `Dado o plano "${context.absolutePath}", valide o plano, aprove-o ou aponte melhorias.`,
    }),
  },
  {
    key: "ImplementPlan",
    displayName: "Implementar plano",
    description: "Pede a implementação do plano vinculado.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "Implementation",
    isReReview: false,
    displayOrder: 20,
    inputs: [],
    render: (context) => ({
      title: `Implementar plano: ${context.displayName}`,
      content: `Implemente o plano "${context.absolutePath}".`,
    }),
  },
  {
    key: "ReviewPlanWithParentPrompt",
    displayName: "Revisar plano com prompt pai",
    description: "Revisa o plano incluindo o prompt original que o gerou como contexto.",
    defaultTargetAgent: "Codex",
    defaultKind: "Planning",
    targetPhaseRole: "PlanReview",
    isReReview: false,
    displayOrder: 30,
    inputs: [],
    render: (context) => ({
      title: `Revisar plano com prompt pai: ${context.displayName}`,
      content: [
        "Pedi ao Claude para rodar o plan-mode usando o prompt abaixo:",
        "",
        "```md",
        context.parentPromptContent,
        "```",
        "",
        `Ele gerou o plano "${context.absolutePath}".`,
        "",
        `Dado o plano "${context.absolutePath}", valide o plano, aprove-o ou aponte melhorias.`,
      ].join("\n"),
    }),
  },
  {
    key: "ReReviewPlan",
    displayName: "Re-review do plano",
    description: "Revalida o plano depois que as correções da revisão anterior foram aplicadas.",
    defaultTargetAgent: "Codex",
    defaultKind: "Planning",
    targetPhaseRole: "PlanReview",
    isReReview: true,
    displayOrder: 40,
    inputs: [],
    render: (context) => ({
      title: `Revisar plano novamente: ${context.displayName}`,
      content:
        `Passei os pontos anteriores para o Claude corrigir no plano "${context.absolutePath}". ` +
        "Valide o plano atualizado novamente, aprove-o se estiver correto ou aponte as melhorias que ainda faltam.",
    }),
  },
  {
    key: "ImplementPlanInWorktree",
    displayName: "Implementar em worktree",
    description: "Implementa o plano em uma worktree separada e abre um PR ao final.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "Implementation",
    isReReview: false,
    displayOrder: 50,
    inputs: [],
    render: (context) => ({
      title: `Implementar em worktree: ${context.displayName}`,
      content: [
        `Implemente o plano \`${context.absolutePath}\` completamente em uma worktree separada.`,
        "",
        "Preserve o checkout principal e as alterações locais não relacionadas. " +
          "Ao terminar, rode as validações aplicáveis, deixe o branch pronto para revisão e abra um PR.",
      ].join("\n"),
    }),
  },
  {
    key: "ReviewPullRequest",
    displayName: "Revisar PR",
    description: "Revisa o PR que implementa o plano, usando o plano como fonte da verdade.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "CodeReview",
    isReReview: false,
    requiresPullRequest: true,
    displayOrder: 60,
    inputs: [
      PULL_REQUEST_INPUT("Informe o numero ou link da PR criada apos a implementacao do plano."),
    ],
    render: (context) => ({
      title: `Revisar ${context.pullRequestReference}: ${context.displayName}`,
      content: [
        "/review",
        "",
        `Revise o ${context.pullRequestReference} que implementa o plano \`${context.absolutePath}\`.`,
        "",
        "Use o plano como fonte da verdade. Verifique se o PR implementa o plano completamente, " +
          "preserva a arquitetura existente, não introduz regressões e se as validações necessárias foram executadas.",
        "",
        "Priorize bugs, riscos de comportamento e testes ausentes. " +
          "Reporte os achados com severidade e referências concretas de arquivo/linha quando possível.",
      ].join("\n"),
    }),
  },
  {
    key: "ReReviewPullRequest",
    displayName: "Re-review de PR",
    description: "Revalida o PR depois que o Codex aplicou as correções da primeira revisão.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "CodeReview",
    isReReview: true,
    requiresPullRequest: true,
    displayOrder: 61,
    inputs: [
      PULL_REQUEST_INPUT("Informe o numero ou link da PR revisada apos as correcoes."),
      CODEX_RESPONSE_INPUT,
    ],
    render: (context) => ({
      title: `Revisar novamente ${context.pullRequestReference}: ${context.displayName}`,
      content: [
        "/review",
        "",
        `Revise novamente o ${context.pullRequestReference} depois que o Codex corrigiu os pontos da revisão anterior.`,
        "",
        `O PR implementa o plano \`${context.absolutePath}\`. Use o plano como fonte da verdade, ` +
          "use o contexto da sessão atual do Claude Code da primeira revisão quando disponível e " +
          "verifique se as correções foram realmente aplicadas sem introduzir regressões.",
        "",
        "Resposta do Codex após aplicar as correções:",
        "",
        "```md",
        context.inputs.codexResponse ?? "",
        "```",
        "",
        "Trate a resposta do Codex como um repasse, não como prova. " +
          "Priorize bugs não resolvidos, riscos de comportamento, regressões e testes ausentes. " +
          "Reporte os achados com severidade e referências concretas de arquivo/linha quando possível. " +
          "Se o PR estiver aceitável agora, diga isso claramente.",
      ].join("\n"),
    }),
  },
  {
    key: "RebaseCurrentBranch",
    displayName: "Atualizar branch com main",
    description: "Faz rebase do branch/worktree atual sobre o main remoto.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "Rebase",
    isReReview: false,
    displayOrder: 65,
    inputs: [],
    render: (context) => ({
      title: `Atualizar branch com main: ${context.displayName}`,
      content: [
        "Atualize meu branch/worktree atual com as últimas alterações do branch main remoto usando rebase.",
        "",
        "Preserve as alterações locais não relacionadas. Se houver conflitos, pare e me avise para resolvermos juntos.",
      ].join("\n"),
    }),
  },
  {
    key: "MergePullRequest",
    displayName: "Fazer merge da PR",
    description: "Faz o merge do PR aprovado e sincroniza o repositório local.",
    defaultTargetAgent: "Codex",
    defaultKind: "General",
    targetPhaseRole: "Merge",
    isReReview: false,
    requiresPullRequest: true,
    displayOrder: 70,
    inputs: [PULL_REQUEST_INPUT("Informe o numero ou link da PR que deve ser mesclada.")],
    render: (context) => ({
      title: `Mesclar ${context.pullRequestReference}: ${context.displayName}`,
      content: [
        `Faça o merge do ${context.pullRequestReference} que implementa o plano \`${context.absolutePath}\`.`,
        "",
        "Antes de mesclar, confirme que o PR está pronto para merge, que as validações necessárias " +
          "passaram e preserve as alterações locais não relacionadas.",
        "",
        "Se houver conflitos ou checks falhando, pare e reporte o bloqueio exato. " +
          "Após o merge, sincronize o branch main local com o remoto, remova a worktree se existir, " +
          "exclua o branch local/remoto se ainda existirem e for seguro, e confirme o estado final do repositório.",
      ].join("\n"),
    }),
  },
];

export function getTemplatesInDisplayOrder(): PromptTemplateDefinition[] {
  return [...PROMPT_TEMPLATES].sort((a, b) => a.displayOrder - b.displayOrder);
}

export function findTemplate(key: string): PromptTemplateDefinition | undefined {
  return PROMPT_TEMPLATES.find((template) => template.key === key);
}

export interface RenderDraftOptions {
  template: PromptTemplateDefinition;
  planAbsolutePath: string;
  planDisplayName: string;
  parentPromptContent: string;
  /** Resolution cascade: explicit input > stored plan PR reference. */
  pullRequestInput?: string;
  storedPullRequestReference?: string;
  inputs?: Record<string, string>;
}

/**
 * Renders a child prompt draft. Mirrors GeneratePromptDraftHandler: resolves
 * the PR reference cascade, validates required inputs, formats and renders.
 */
export function renderPromptDraft(options: RenderDraftOptions): RenderedPromptTemplate {
  const { template } = options;
  const inputs = { ...(options.inputs ?? {}) };

  let pullRequestReference: string | undefined;
  if (template.requiresPullRequest) {
    const rawPr =
      options.pullRequestInput?.trim() ||
      inputs.pullRequest?.trim() ||
      options.storedPullRequestReference?.trim();
    if (!rawPr) {
      throw new Error("Este template exige uma referência de PR (#123 ou URL).");
    }
    pullRequestReference = formatPullRequestReference(rawPr);
  }

  for (const input of template.inputs) {
    if (input.key === "pullRequest") {
      continue;
    }
    const value = inputs[input.key]?.trim() ?? "";
    if (input.required && value.length === 0) {
      throw new Error(`O campo "${input.label}" é obrigatório.`);
    }
    if (input.multiline && value.length > MAX_MULTILINE_INPUT_CHARS) {
      throw new Error(`O campo "${input.label}" excede ${MAX_MULTILINE_INPUT_CHARS} caracteres.`);
    }
  }

  return template.render({
    absolutePath: options.planAbsolutePath,
    displayName: options.planDisplayName,
    parentPromptContent: options.parentPromptContent,
    pullRequestReference,
    inputs,
  });
}
