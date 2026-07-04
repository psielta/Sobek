/**
 * Workspace-defined child prompt templates: Markdown files with a frontmatter
 * header living in `.sobek/templates/<slug>.md`. They join the built-in Thoth
 * catalog in the generation flow, with the same placeholders and an optional
 * workflow phase advance. Generated children carry `custom:<slug>` as their
 * sourceTemplateKey.
 */

import type { PromptKind, TargetAgent } from "./prompt";
import type { WorkflowPhaseRole } from "./workflow";
import type {
  PromptTemplateContext,
  PromptTemplateDefinition,
  PromptTemplateInput,
  RenderedPromptTemplate,
} from "./templates";

export const CUSTOM_TEMPLATE_PREFIX = "custom:";

export interface CustomTemplateError {
  slug: string;
  message: string;
}

export type ParseCustomTemplateResult =
  | { definition: PromptTemplateDefinition; error?: undefined }
  | { definition?: undefined; error: CustomTemplateError };

const TARGET_AGENTS: TargetAgent[] = ["ClaudeCode", "Codex", "Grok"];
const KINDS: PromptKind[] = ["General", "Planning"];
const PHASE_ROLES: WorkflowPhaseRole[] = [
  "PromptEngineering",
  "Planning",
  "PlanReview",
  "PlanCorrection",
  "Implementation",
  "CodeReview",
  "ReviewCorrection",
  "PracticalTest",
  "Rebase",
  "Merge",
];

interface Frontmatter {
  scalars: Record<string, string>;
  inputs: Array<Record<string, string>>;
}

/**
 * Minimal YAML-subset frontmatter parser: top-level `key: value` scalars plus
 * an `inputs:` list of flat `- key: value` objects. Full-line comments and
 * ` # ` suffixes on bare values are stripped; quoted values keep everything.
 */
function parseFrontmatter(raw: string): Frontmatter {
  const scalars: Record<string, string> = {};
  const inputs: Array<Record<string, string>> = [];
  let currentInput: Record<string, string> | undefined;
  let inInputs = false;

  const parseValue = (value: string): string => {
    let trimmed = value.trim();
    const quoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2);
    if (quoted) {
      return trimmed.slice(1, -1);
    }
    const commentIndex = trimmed.indexOf(" #");
    if (commentIndex >= 0) {
      trimmed = trimmed.slice(0, commentIndex).trim();
    }
    return trimmed;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const listMatch = /^\s*-\s+(\w+):\s*(.*)$/.exec(line);
    if (inInputs && listMatch) {
      currentInput = { [listMatch[1]]: parseValue(listMatch[2]) };
      inputs.push(currentInput);
      continue;
    }
    const indentedMatch = /^\s+(\w+):\s*(.*)$/.exec(line);
    if (inInputs && currentInput && indentedMatch && /^\s/.test(line)) {
      currentInput[indentedMatch[1]] = parseValue(indentedMatch[2]);
      continue;
    }
    const topMatch = /^(\w+):\s*(.*)$/.exec(line);
    if (topMatch) {
      inInputs = topMatch[1] === "inputs";
      currentInput = undefined;
      if (!inInputs) {
        scalars[topMatch[1]] = parseValue(topMatch[2]);
      }
    }
  }
  return { scalars, inputs };
}

function parseBoolean(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

/** Replaces the shared placeholder tokens plus `{input:<key>}` entries. */
export function substitutePlaceholders(template: string, context: PromptTemplateContext): string {
  return template
    .replace(/\{AbsolutePath\}/g, context.absolutePath)
    .replace(/\{DisplayName\}/g, context.displayName)
    .replace(/\{ParentPromptContent\}/g, context.parentPromptContent)
    .replace(/\{PullRequestReference\}/g, context.pullRequestReference ?? "")
    .replace(/\{input:([\w-]+)\}/g, (_match, key: string) => context.inputs[key] ?? "");
}

export function parseCustomTemplate(slug: string, fileContent: string): ParseCustomTemplateResult {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(fileContent);
  if (!match) {
    return {
      error: { slug, message: "Frontmatter ausente: o arquivo deve começar com um bloco ---." },
    };
  }
  const { scalars, inputs } = parseFrontmatter(match[1]);
  const body = match[2].trim();
  if (!body) {
    return { error: { slug, message: "O corpo do template (após o frontmatter) está vazio." } };
  }

  const targetAgent = (scalars.targetAgent ?? "ClaudeCode") as TargetAgent;
  if (!TARGET_AGENTS.includes(targetAgent)) {
    return {
      error: {
        slug,
        message: `targetAgent inválido: "${scalars.targetAgent}" (use ClaudeCode, Codex ou Grok).`,
      },
    };
  }
  const kind = (scalars.kind ?? "General") as PromptKind;
  if (!KINDS.includes(kind)) {
    return {
      error: { slug, message: `kind inválido: "${scalars.kind}" (use General ou Planning).` },
    };
  }
  let targetPhaseRole: WorkflowPhaseRole | undefined;
  if (scalars.targetPhaseRole) {
    if (!PHASE_ROLES.includes(scalars.targetPhaseRole as WorkflowPhaseRole)) {
      return {
        error: {
          slug,
          message: `targetPhaseRole inválido: "${scalars.targetPhaseRole}" (valores: ${PHASE_ROLES.join(", ")}).`,
        },
      };
    }
    targetPhaseRole = scalars.targetPhaseRole as WorkflowPhaseRole;
  }

  const name = scalars.name?.trim() || slug;
  const title = scalars.title?.trim() || `${name}: {DisplayName}`;

  const templateInputs: PromptTemplateInput[] = inputs
    .filter((input) => input.key)
    .map((input) => ({
      key: input.key,
      label: input.label || input.key,
      placeholder: input.placeholder || "",
      helpText: input.helpText || "",
      required: input.required === undefined ? true : parseBoolean(input.required),
      multiline: parseBoolean(input.multiline),
    }));

  const requiresPullRequest = /\{PullRequestReference\}/.test(`${title}\n${body}`);

  const definition: PromptTemplateDefinition = {
    key: `${CUSTOM_TEMPLATE_PREFIX}${slug}`,
    displayName: name,
    description: scalars.description?.trim() || "",
    defaultTargetAgent: targetAgent,
    defaultKind: kind,
    targetPhaseRole,
    isReReview: parseBoolean(scalars.isReReview),
    requiresPullRequest,
    // Custom templates sort after the built-ins (highest built-in order: 70).
    displayOrder: 1000,
    inputs: templateInputs,
    render: (context: PromptTemplateContext): RenderedPromptTemplate => ({
      title: substitutePlaceholders(title, context),
      content: substitutePlaceholders(body, context),
    }),
  };
  return { definition };
}

export function isCustomTemplateKey(key: string): boolean {
  return key.startsWith(CUSTOM_TEMPLATE_PREFIX);
}

export function customTemplateSlug(key: string): string {
  return key.slice(CUSTOM_TEMPLATE_PREFIX.length);
}
