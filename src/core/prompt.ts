/**
 * Prompt domain ported from Thoth (`backend/src/Thoth.Domain/Prompts/`),
 * adapted to Sobek's single-workspace model: the open VS Code folder is the
 * working directory every prompt is bound to.
 */

import type { Workflow } from "./workflow";

export type PromptStatus = "Draft" | "Ready" | "Archived";

export const PROMPT_STATUS_LABELS: Record<PromptStatus, string> = {
  Draft: "Rascunho",
  Ready: "Pronto",
  Archived: "Arquivado",
};

export type PromptKind = "General" | "Planning";

export const PROMPT_KIND_LABELS: Record<PromptKind, string> = {
  General: "Geral",
  Planning: "Planejamento",
};

export type TargetAgent = "ClaudeCode" | "Codex" | "Grok";

export const TARGET_AGENT_LABELS: Record<TargetAgent, string> = {
  ClaudeCode: "Claude Code",
  Codex: "Codex",
  Grok: "Grok",
};

export interface FileReference {
  relativePath: string;
  exists: boolean;
}

/** Immutable snapshot created on every content/status mutation. */
export interface PromptVersion {
  versionNumber: number;
  title: string;
  content: string;
  targetAgent: TargetAgent;
  kind: PromptKind;
  status: PromptStatus;
  changeNote: "Created" | "Updated" | "Status changed";
  createdAt: string;
}

/**
 * Minimal stand-in for Thoth's LinkedDocument: a Markdown plan (typically
 * written by an agent) that child prompts are generated from. Sobek keeps the
 * pointer and PR reference, without background watchers.
 */
export interface LinkedPlan {
  /** Workspace-relative or absolute path — plans may live outside the repo. */
  path: string;
  displayName: string;
  pullRequestReference?: string;
}

export interface Prompt {
  id: string;
  parentPromptId?: string;
  title: string;
  content: string;
  targetAgent: TargetAgent;
  kind: PromptKind;
  status: PromptStatus;
  currentVersion: number;
  boardRank: number;
  /** Template key that generated this child prompt, when applicable. */
  sourceTemplateKey?: string;
  fileReferences: FileReference[];
  linkedPlan?: LinkedPlan;
  /** Root prompts own a workflow; child prompts never do. */
  workflow?: Workflow;
  createdAt: string;
  updatedAt: string;
}

export function isRootPrompt(prompt: Prompt): boolean {
  return !prompt.parentPromptId;
}

/**
 * Formats a pull request reference the way Thoth's PullRequestTemplateHelpers
 * does: `#123`, `PR 123` and URLs pass through; anything else becomes `PR #x`.
 */
export function formatPullRequestReference(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.toUpperCase().startsWith("PR ") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }
  return `PR #${trimmed}`;
}
