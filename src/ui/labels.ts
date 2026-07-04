import * as vscode from "vscode";
import type { PromptKind, PromptStatus, TargetAgent } from "../core/prompt";
import type { WorkflowActor, WorkflowEventType } from "../core/workflow";

/**
 * Localized display labels for domain enums. The domain modules stay free of
 * `vscode`, so translation happens at the UI boundary via vscode.l10n.
 */

export function promptStatusLabel(status: PromptStatus): string {
  switch (status) {
    case "Draft":
      return vscode.l10n.t("Draft");
    case "Ready":
      return vscode.l10n.t("Ready");
    case "Archived":
      return vscode.l10n.t("Archived");
  }
}

export function promptKindLabel(kind: PromptKind): string {
  switch (kind) {
    case "General":
      return vscode.l10n.t("General");
    case "Planning":
      return vscode.l10n.t("Planning");
  }
}

export function targetAgentLabel(agent: TargetAgent): string {
  switch (agent) {
    case "ClaudeCode":
      return "Claude Code";
    case "Codex":
      return "Codex";
    case "Grok":
      return "Grok";
  }
}

export function workflowActorLabel(actor: WorkflowActor): string {
  switch (actor) {
    case "ClaudeCode":
      return "Claude";
    case "Codex":
      return "Codex";
    case "Human":
      return vscode.l10n.t("You");
    case "Grok":
      return "Grok";
  }
}

export function workflowEventLabel(type: WorkflowEventType): string {
  switch (type) {
    case "WorkflowStarted":
      return vscode.l10n.t("Workflow started");
    case "PhaseChanged":
      return vscode.l10n.t("Phase changed");
    case "ActorChanged":
      return vscode.l10n.t("Owner changed");
    case "Note":
      return vscode.l10n.t("Note");
    case "Completed":
      return vscode.l10n.t("Completed");
    case "Reopened":
      return vscode.l10n.t("Reopened");
    case "PhasesEdited":
      return vscode.l10n.t("Phases edited");
  }
}
