/**
 * Executes the chat assistant's function calls against the prompt store.
 * Failures never throw: they come back as `{ error }` so the model can react
 * and explain the problem to the user.
 */

import * as path from "node:path";
import type { Prompt, PromptKind, TargetAgent } from "../core/prompt";
import { getTemplatesInDisplayOrder, renderPromptDraft } from "../core/templates";
import { addNote, advancePhase } from "../core/workflow";
import type { PromptStore } from "../store/prompt-store";
import { refreshPromptDocument } from "../ui/prompt-document";
import type { GeminiFunctionCall } from "./gemini-client";
import { clampContent, optionalStringArg, requireStringArg } from "./tool-declarations";

export interface AssistantToolHost {
  store: PromptStore;
  getActivePromptId(): string | undefined;
}

const PROMPT_KINDS: PromptKind[] = ["General", "Planning"];
const TARGET_AGENTS: TargetAgent[] = ["ClaudeCode", "Codex", "Grok"];

export class AssistantToolExecutor {
  constructor(private readonly host: AssistantToolHost) {}

  /** Never throws: failures come back as { error } for the functionResponse. */
  async execute(call: GeminiFunctionCall): Promise<Record<string, unknown>> {
    try {
      return await this.dispatch(call.name, call.args ?? {});
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case "get_active_prompt":
        return this.describePrompt(this.resolvePrompt(args));
      case "get_prompt":
        return this.describePrompt(this.requirePrompt(requireStringArg(args, "prompt_id")));
      case "list_prompts":
        return this.listPrompts(args.include_children === true);
      case "get_workflow_state":
        return this.workflowState(this.resolvePrompt(args));
      case "list_templates":
        return this.listTemplates();
      case "update_prompt_content":
        return this.updateContent(this.resolvePrompt(args), requireStringArg(args, "content"));
      case "update_prompt_title": {
        const prompt = this.resolvePrompt(args);
        const updated = await this.host.store.update(prompt.id, {
          title: requireStringArg(args, "title").trim(),
        });
        return { ok: true, id: updated.id, title: updated.title };
      }
      case "create_prompt":
        return this.createPrompt(args);
      case "create_child_prompt":
        return this.createChildPrompt(args);
      case "add_workflow_note": {
        const prompt = this.resolvePrompt(args);
        const note = requireStringArg(args, "note").trim();
        await this.host.store.mutateWorkflow(prompt.id, (workflow, now) =>
          addNote(workflow, note, now)
        );
        return { ok: true, id: prompt.id };
      }
      case "advance_workflow": {
        const prompt = this.resolvePrompt(args);
        const note = optionalStringArg(args, "note");
        const updated = await this.host.store.mutateWorkflow(prompt.id, (workflow, now) =>
          advancePhase(workflow, now, note)
        );
        return {
          ok: true,
          id: updated.id,
          currentPhase: updated.workflow?.currentPhaseName,
          workflowStatus: updated.workflow?.status,
        };
      }
      case "set_prompt_status": {
        const prompt = this.resolvePrompt(args);
        const status = requireStringArg(args, "status");
        // The schema enum is advisory only — re-validate so "Archived" can
        // never arrive at the store through the assistant.
        if (status !== "Draft" && status !== "Ready") {
          return { error: `Status não permitido pela assistente: ${status}` };
        }
        const updated = await this.host.store.updateStatus(prompt.id, status);
        return { ok: true, id: updated.id, status: updated.status };
      }
      default:
        return { error: `Ferramenta desconhecida: ${name}` };
    }
  }

  /** args.prompt_id wins; otherwise the prompt open in the editor. */
  private resolvePrompt(args: Record<string, unknown>): Prompt {
    const explicit = optionalStringArg(args, "prompt_id") ?? optionalStringArg(args, "parent_prompt_id");
    if (explicit) {
      return this.requirePrompt(explicit);
    }
    const activeId = this.host.getActivePromptId();
    if (!activeId) {
      throw new Error(
        "Nenhum prompt ativo: peça ao usuário para abrir um prompt.md ou informe prompt_id."
      );
    }
    return this.requirePrompt(activeId);
  }

  private requirePrompt(id: string): Prompt {
    const prompt = this.host.store.get(id);
    if (!prompt) {
      throw new Error(`Prompt não encontrado: ${id}`);
    }
    return prompt;
  }

  private describePrompt(prompt: Prompt): Record<string, unknown> {
    const { content, truncated } = clampContent(prompt.content);
    return {
      id: prompt.id,
      title: prompt.title,
      status: prompt.status,
      kind: prompt.kind,
      targetAgent: prompt.targetAgent,
      isChild: !!prompt.parentPromptId,
      parentPromptId: prompt.parentPromptId,
      hasLinkedPlan: !!prompt.linkedPlan,
      currentVersion: prompt.currentVersion,
      content,
      contentTruncated: truncated,
    };
  }

  private listPrompts(includeChildren: boolean): Record<string, unknown> {
    const summarize = (prompt: Prompt) => ({
      id: prompt.id,
      title: prompt.title,
      status: prompt.status,
      kind: prompt.kind,
      isChild: !!prompt.parentPromptId,
      updatedAt: prompt.updatedAt,
    });
    const prompts = this.host.store.listRoots().flatMap((root) => {
      const entries = [summarize(root)];
      if (includeChildren) {
        entries.push(...this.host.store.listChildren(root.id).map(summarize));
      }
      return entries;
    });
    return { prompts };
  }

  private workflowState(prompt: Prompt): Record<string, unknown> {
    const owner = prompt.parentPromptId
      ? this.host.store.get(prompt.parentPromptId)
      : prompt;
    const workflow = owner?.workflow;
    if (!workflow) {
      return { error: "O prompt não possui workflow." };
    }
    return {
      promptId: owner!.id,
      status: workflow.status,
      currentPhase: workflow.currentPhaseName,
      currentActor: workflow.currentActor,
      iteration: workflow.currentPhaseIteration,
      phases: workflow.phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        role: phase.role,
        orderIndex: phase.orderIndex,
      })),
      recentNotes: workflow.events
        .filter((event) => event.note)
        .slice(-5)
        .map((event) => event.note),
    };
  }

  private listTemplates(): Record<string, unknown> {
    const describe = (template: ReturnType<typeof getTemplatesInDisplayOrder>[number]) => ({
      key: template.key,
      displayName: template.displayName,
      description: template.description,
      requiresPullRequest: template.requiresPullRequest === true,
      targetPhaseRole: template.targetPhaseRole,
      inputs: template.inputs.map((input) => ({
        key: input.key,
        label: input.label,
        required: input.required === true,
        multiline: input.multiline === true,
        helpText: input.helpText,
      })),
    });
    return {
      templates: [
        ...getTemplatesInDisplayOrder().map(describe),
        ...this.host.store.getCustomTemplates().map(describe),
      ],
    };
  }

  private async updateContent(prompt: Prompt, content: string): Promise<Record<string, unknown>> {
    const updated = await this.host.store.update(prompt.id, { content });
    await refreshPromptDocument(this.host.store, prompt.id, content);
    return { ok: true, id: updated.id, version: updated.currentVersion };
  }

  private async createPrompt(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = optionalStringArg(args, "kind");
    const targetAgent = optionalStringArg(args, "target_agent");
    if (kind && !PROMPT_KINDS.includes(kind as PromptKind)) {
      return { error: `Tipo inválido: ${kind}` };
    }
    if (targetAgent && !TARGET_AGENTS.includes(targetAgent as TargetAgent)) {
      return { error: `Agente inválido: ${targetAgent}` };
    }
    const created = await this.host.store.create({
      title: requireStringArg(args, "title").trim(),
      content: requireStringArg(args, "content"),
      kind: kind as PromptKind | undefined,
      targetAgent: targetAgent as TargetAgent | undefined,
    });
    return { ok: true, id: created.id, title: created.title };
  }

  private async createChildPrompt(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const parent = this.resolvePrompt(args);
    if (parent.parentPromptId) {
      return { error: "Prompts filhos não geram outros filhos; informe um prompt raiz." };
    }
    if (parent.status === "Archived") {
      return { error: "Prompt arquivado não gera prompts filhos." };
    }
    const plan = parent.linkedPlan;
    if (!plan) {
      return {
        error:
          "O prompt pai não tem plano vinculado. Peça ao usuário para vincular um plano Markdown primeiro.",
      };
    }
    const templateKey = requireStringArg(args, "template_key");
    const template = this.host.store.resolveTemplate(templateKey);
    if (!template) {
      return { error: `Template não encontrado: ${templateKey}. Use list_templates.` };
    }

    const inputs: Record<string, string> = {};
    if (args.inputs && typeof args.inputs === "object") {
      for (const [key, value] of Object.entries(args.inputs as Record<string, unknown>)) {
        if (typeof value === "string") {
          inputs[key] = value;
        }
      }
    }
    const pullRequestInput = optionalStringArg(args, "pull_request");

    // renderPromptDraft throws user-facing messages for missing PR/required
    // inputs — surfaced as { error } by execute()'s catch.
    const draft = renderPromptDraft({
      template,
      planAbsolutePath: path.resolve(this.host.store.root, plan.path),
      planDisplayName: plan.displayName,
      parentPromptContent: parent.content,
      pullRequestInput,
      storedPullRequestReference: plan.pullRequestReference,
      inputs,
    });

    const child = await this.host.store.create({
      title: optionalStringArg(args, "title")?.trim() ?? draft.title,
      content: draft.content,
      parentPromptId: parent.id,
      targetAgent: template.defaultTargetAgent,
      kind: template.defaultKind,
      status: "Draft",
      sourceTemplateKey: template.key,
    });
    if (pullRequestInput?.trim()) {
      await this.host.store.setPullRequestReference(parent.id, pullRequestInput.trim());
    }
    const updatedParent = this.host.store.get(parent.id);
    return {
      ok: true,
      id: child.id,
      title: child.title,
      parentPhase: updatedParent?.workflow?.currentPhaseName,
    };
  }
}
