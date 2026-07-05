/**
 * File-backed prompt store: Sobek's replacement for Thoth's PostgreSQL + EF
 * persistence, scoped to the open workspace.
 *
 * Layout under `<workspace>/.sobek/`:
 *   settings.json                 — workspace-level settings (phase template, AI context flag)
 *   prompts/<id>/meta.json        — prompt metadata, workflow snapshot and timeline
 *   prompts/<id>/prompt.md        — current Markdown content
 *   prompts/<id>/versions.json    — immutable version snapshots
 *   prompts/<id>/plan-versions.json — linked plan content snapshots
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { newId } from "../lib/ids";
import {
  parseCustomTemplate,
  type CustomTemplateError,
} from "../core/custom-templates";
import { parseMentions, resolveMentionPath } from "../core/mentions";
import type {
  FileReference,
  LinkedPlan,
  LinkedPlanVersion,
  Prompt,
  PromptKind,
  PromptStatus,
  PromptVersion,
  TargetAgent,
} from "../core/prompt";
import { findTemplate, type PromptTemplateDefinition } from "../core/templates";
import {
  advanceForGeneratedChild,
  DEFAULT_PHASE_TEMPLATE,
  startWorkflow,
  type PhaseTemplate,
  type Workflow,
} from "../core/workflow";
import { readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "./json-file";

export interface SobekSettings {
  phaseTemplate: PhaseTemplate[];
  enableAiContext: boolean;
}

export const DEFAULT_SETTINGS: SobekSettings = {
  phaseTemplate: DEFAULT_PHASE_TEMPLATE,
  enableAiContext: false,
};

type PromptMeta = Omit<Prompt, "content">;

export interface CreatePromptInput {
  title: string;
  content: string;
  targetAgent?: TargetAgent;
  kind?: PromptKind;
  status?: PromptStatus;
  parentPromptId?: string;
  sourceTemplateKey?: string;
}

export interface UpdatePromptInput {
  title?: string;
  content?: string;
  targetAgent?: TargetAgent;
  kind?: PromptKind;
}

export type StoreListener = () => void;

export class PromptStore {
  private prompts = new Map<string, Prompt>();
  private settings: SobekSettings = DEFAULT_SETTINGS;
  private listeners = new Set<StoreListener>();
  private archiveListeners = new Set<(promptId: string) => void>();
  private loaded = false;
  private customTemplates: PromptTemplateDefinition[] = [];
  private customTemplateErrors: CustomTemplateError[] = [];

  constructor(
    private readonly workspaceRoot: string,
    /** Default phase template for new settings (localized by the caller). */
    private readonly defaultPhaseTemplate: PhaseTemplate[] = DEFAULT_PHASE_TEMPLATE
  ) {}

  get root(): string {
    return this.workspaceRoot;
  }

  get sobekDir(): string {
    return path.join(this.workspaceRoot, ".sobek");
  }

  private promptDir(id: string): string {
    return path.join(this.sobekDir, "prompts", id);
  }

  promptMarkdownPath(id: string): string {
    return path.join(this.promptDir(id), "prompt.md");
  }

  get templatesDir(): string {
    return path.join(this.sobekDir, "templates");
  }

  customTemplatePath(slug: string): string {
    return path.join(this.templatesDir, `${slug}.md`);
  }

  onDidChange(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fired when a prompt transitions to Archived (side effects live outside). */
  onDidArchive(listener: (promptId: string) => void): () => void {
    this.archiveListeners.add(listener);
    return () => this.archiveListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async load(): Promise<void> {
    this.prompts.clear();
    const stored = await readJsonFile<Partial<SobekSettings>>(
      path.join(this.sobekDir, "settings.json")
    );
    this.settings = {
      ...DEFAULT_SETTINGS,
      phaseTemplate: this.defaultPhaseTemplate,
      ...stored,
    };

    let entries: string[] = [];
    try {
      entries = await fs.readdir(path.join(this.sobekDir, "prompts"));
    } catch {
      entries = [];
    }
    for (const id of entries) {
      const meta = await readJsonFile<PromptMeta>(path.join(this.promptDir(id), "meta.json"));
      if (!meta) {
        continue;
      }
      // Early betas stored the plan pointer as `relativePath`.
      const legacyPlan = meta.linkedPlan as (LinkedPlan & { relativePath?: string }) | undefined;
      if (legacyPlan && !legacyPlan.path && legacyPlan.relativePath) {
        meta.linkedPlan = { ...legacyPlan, path: legacyPlan.relativePath };
      }
      const content = (await readTextFile(this.promptMarkdownPath(id))) ?? "";
      this.prompts.set(id, { ...meta, content });
    }
    await this.reloadCustomTemplates(false);
    this.loaded = true;
    this.notify();
  }

  /** Reads workspace-defined templates from .sobek/templates/*.md. */
  async reloadCustomTemplates(notify = true): Promise<void> {
    const templates: PromptTemplateDefinition[] = [];
    const errors: CustomTemplateError[] = [];
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.templatesDir);
    } catch {
      entries = [];
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      const slug = entry.slice(0, -3);
      const content = await readTextFile(path.join(this.templatesDir, entry));
      if (content === undefined) {
        continue;
      }
      const result = parseCustomTemplate(slug, content);
      if (result.definition) {
        templates.push(result.definition);
      } else {
        errors.push(result.error);
      }
    }
    this.customTemplates = templates;
    this.customTemplateErrors = errors;
    if (notify) {
      this.notify();
    }
  }

  getCustomTemplates(): PromptTemplateDefinition[] {
    return this.customTemplates;
  }

  getCustomTemplateErrors(): CustomTemplateError[] {
    return this.customTemplateErrors;
  }

  /** Built-in template by key, or a workspace template via `custom:<slug>`. */
  resolveTemplate(key: string): PromptTemplateDefinition | undefined {
    return findTemplate(key) ?? this.customTemplates.find((template) => template.key === key);
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error("PromptStore.load() must run before use.");
    }
  }

  getSettings(): SobekSettings {
    return this.settings;
  }

  async updateSettings(patch: Partial<SobekSettings>): Promise<SobekSettings> {
    this.settings = { ...this.settings, ...patch };
    await writeJsonFile(path.join(this.sobekDir, "settings.json"), this.settings);
    this.notify();
    return this.settings;
  }

  /** Root prompts only — the main workspace listing never shows children. */
  listRoots(): Prompt[] {
    this.ensureLoaded();
    return [...this.prompts.values()]
      .filter((prompt) => !prompt.parentPromptId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listChildren(parentPromptId: string): Prompt[] {
    this.ensureLoaded();
    return [...this.prompts.values()]
      .filter((prompt) => prompt.parentPromptId === parentPromptId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listAll(): Prompt[] {
    this.ensureLoaded();
    return [...this.prompts.values()];
  }

  get(id: string): Prompt | undefined {
    this.ensureLoaded();
    return this.prompts.get(id);
  }

  require(id: string): Prompt {
    const prompt = this.get(id);
    if (!prompt) {
      throw new Error("Prompt não encontrado.");
    }
    return prompt;
  }

  findByMarkdownPath(filePath: string): Prompt | undefined {
    this.ensureLoaded();
    // Windows paths from the VS Code API vary in drive-letter casing, so the
    // comparison must be case-insensitive there.
    const normalize = (candidate: string): string => {
      const resolved = path.resolve(candidate);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const normalized = normalize(filePath);
    for (const prompt of this.prompts.values()) {
      if (normalize(this.promptMarkdownPath(prompt.id)) === normalized) {
        return prompt;
      }
    }
    return undefined;
  }

  private async buildFileReferences(content: string): Promise<FileReference[]> {
    const seen = new Map<string, FileReference>();
    for (const mention of parseMentions(content)) {
      const normalizedKey = mention.raw.replace(/\\/g, "/").toLowerCase();
      if (seen.has(normalizedKey)) {
        continue;
      }
      const resolved = resolveMentionPath(this.workspaceRoot, mention.raw);
      let exists = false;
      if (resolved) {
        try {
          await fs.stat(resolved);
          exists = true;
        } catch {
          exists = false;
        }
      }
      seen.set(normalizedKey, { relativePath: mention.raw.replace(/\\/g, "/"), exists });
    }
    return [...seen.values()];
  }

  private async persist(prompt: Prompt): Promise<void> {
    const { content, ...meta } = prompt;
    await writeJsonFile(path.join(this.promptDir(prompt.id), "meta.json"), meta);
    await writeTextFile(this.promptMarkdownPath(prompt.id), content);
  }

  private async appendVersion(prompt: Prompt, changeNote: PromptVersion["changeNote"]): Promise<void> {
    const versionsPath = path.join(this.promptDir(prompt.id), "versions.json");
    const versions = (await readJsonFile<PromptVersion[]>(versionsPath)) ?? [];
    versions.push({
      versionNumber: prompt.currentVersion,
      title: prompt.title,
      content: prompt.content,
      targetAgent: prompt.targetAgent,
      kind: prompt.kind,
      status: prompt.status,
      changeNote,
      createdAt: prompt.updatedAt,
    });
    await writeJsonFile(versionsPath, versions);
  }

  async getVersions(id: string): Promise<PromptVersion[]> {
    this.require(id);
    return (await readJsonFile<PromptVersion[]>(path.join(this.promptDir(id), "versions.json"))) ?? [];
  }

  /**
   * Creates a prompt. Root prompts that are not archived automatically start
   * a workflow on phase 0 ("Engenharia de prompt", human actor). A child
   * created from a template advances the PARENT's workflow to the template's
   * target phase role — the child itself never owns a workflow.
   */
  async create(input: CreatePromptInput): Promise<Prompt> {
    this.ensureLoaded();
    const now = new Date().toISOString();
    const parent = input.parentPromptId ? this.require(input.parentPromptId) : undefined;

    const prompt: Prompt = {
      id: newId(),
      parentPromptId: parent?.id,
      title: input.title,
      content: input.content,
      targetAgent: input.targetAgent ?? "ClaudeCode",
      kind: input.kind ?? "General",
      status: input.status ?? "Draft",
      currentVersion: 1,
      boardRank: 0,
      sourceTemplateKey: input.sourceTemplateKey,
      fileReferences: await this.buildFileReferences(input.content),
      createdAt: now,
      updatedAt: now,
    };

    if (!parent && prompt.status !== "Archived") {
      prompt.workflow = startWorkflow(this.settings.phaseTemplate, now);
    }

    this.prompts.set(prompt.id, prompt);
    await this.persist(prompt);
    await this.appendVersion(prompt, "Created");

    if (parent && input.sourceTemplateKey) {
      const template = this.resolveTemplate(input.sourceTemplateKey);
      if (template?.targetPhaseRole && parent.workflow) {
        const advanced = advanceForGeneratedChild(
          parent.workflow,
          template.targetPhaseRole,
          template.displayName,
          now
        );
        if (advanced) {
          parent.boardRank = 0;
          parent.updatedAt = now;
          await this.persist(parent);
        }
      }
    }

    this.notify();
    return prompt;
  }

  /** Content/metadata update; snapshots a new version with note "Updated". */
  async update(id: string, input: UpdatePromptInput): Promise<Prompt> {
    const prompt = this.require(id);
    const now = new Date().toISOString();
    if (input.title !== undefined) {
      prompt.title = input.title;
    }
    if (input.content !== undefined) {
      prompt.content = input.content;
      prompt.fileReferences = await this.buildFileReferences(input.content);
    }
    if (input.targetAgent !== undefined) {
      prompt.targetAgent = input.targetAgent;
    }
    if (input.kind !== undefined) {
      prompt.kind = input.kind;
    }
    prompt.currentVersion += 1;
    prompt.updatedAt = now;
    await this.persist(prompt);
    await this.appendVersion(prompt, "Updated");
    this.notify();
    return prompt;
  }

  /**
   * Status change; snapshots a version with note "Status changed".
   * Archiving is the transition with side effects (terminals are killed by
   * the terminal manager reacting to this event).
   */
  async updateStatus(id: string, status: PromptStatus): Promise<Prompt> {
    const prompt = this.require(id);
    const previous = prompt.status;
    const now = new Date().toISOString();
    prompt.status = status;
    prompt.currentVersion += 1;
    prompt.updatedAt = now;
    await this.persist(prompt);
    await this.appendVersion(prompt, "Status changed");
    if (status === "Archived" && previous !== "Archived") {
      for (const listener of this.archiveListeners) {
        listener(id);
      }
    }
    this.notify();
    return prompt;
  }

  /** Absolute filesystem path of a linked plan (paths may be workspace-relative). */
  resolvePlanPath(plan: LinkedPlan): string {
    return path.resolve(this.workspaceRoot, plan.path);
  }

  private planVersionsPath(id: string): string {
    return path.join(this.promptDir(id), "plan-versions.json");
  }

  async getPlanVersions(id: string): Promise<LinkedPlanVersion[]> {
    this.require(id);
    return (await readJsonFile<LinkedPlanVersion[]>(this.planVersionsPath(id))) ?? [];
  }

  /**
   * Snapshots the linked plan's current on-disk content, exactly like Thoth's
   * linked document versions: no-op (returns undefined) when the prompt has no
   * plan, the file is unreadable, or the content matches the latest version.
   */
  async capturePlanVersion(
    id: string,
    origin: LinkedPlanVersion["origin"]
  ): Promise<LinkedPlanVersion | undefined> {
    const prompt = this.require(id);
    if (!prompt.linkedPlan) {
      return undefined;
    }
    const content = await readTextFile(this.resolvePlanPath(prompt.linkedPlan));
    if (content === undefined) {
      return undefined;
    }
    const versions = await this.getPlanVersions(id);
    if (versions.at(-1)?.content === content) {
      return undefined;
    }
    const version: LinkedPlanVersion = {
      versionNumber: (versions.at(-1)?.versionNumber ?? 0) + 1,
      content,
      capturedAt: new Date().toISOString(),
      origin,
    };
    versions.push(version);
    await writeJsonFile(this.planVersionsPath(id), versions);
    this.notify();
    return version;
  }

  /**
   * Links/unlinks the plan. Pointing at a different file resets the version
   * history and captures the plan's current content as version 1; unlinking
   * discards the history.
   */
  async setLinkedPlan(id: string, plan: LinkedPlan | undefined): Promise<Prompt> {
    const prompt = this.require(id);
    const previousPath = prompt.linkedPlan
      ? this.resolvePlanPath(prompt.linkedPlan)
      : undefined;
    prompt.linkedPlan = plan;
    prompt.updatedAt = new Date().toISOString();
    await this.persist(prompt);
    const newPath = plan ? this.resolvePlanPath(plan) : undefined;
    if (newPath !== previousPath) {
      await fs.rm(this.planVersionsPath(id), { force: true });
      if (plan) {
        await this.capturePlanVersion(id, "Linked");
      }
    }
    this.notify();
    return prompt;
  }

  /** Pauses/resumes plan version capturing (Thoth's monitoring pause/resume). */
  async setPlanMonitoringPaused(id: string, paused: boolean): Promise<Prompt> {
    const prompt = this.require(id);
    if (!prompt.linkedPlan) {
      throw new Error("O prompt não tem plano vinculado.");
    }
    prompt.linkedPlan = { ...prompt.linkedPlan, monitoringPaused: paused || undefined };
    prompt.updatedAt = new Date().toISOString();
    await this.persist(prompt);
    this.notify();
    return prompt;
  }

  async setPullRequestReference(id: string, reference: string): Promise<Prompt> {
    const prompt = this.require(id);
    if (!prompt.linkedPlan) {
      throw new Error("O prompt não tem plano vinculado.");
    }
    prompt.linkedPlan = { ...prompt.linkedPlan, pullRequestReference: reference };
    prompt.updatedAt = new Date().toISOString();
    await this.persist(prompt);
    this.notify();
    return prompt;
  }

  /** Applies a mutation to the prompt's workflow and persists the result. */
  async mutateWorkflow(id: string, mutate: (workflow: Workflow, now: string) => void): Promise<Prompt> {
    const prompt = this.require(id);
    if (!prompt.workflow) {
      throw new Error("O prompt não possui workflow.");
    }
    const now = new Date().toISOString();
    mutate(prompt.workflow, now);
    prompt.updatedAt = now;
    await this.persist(prompt);
    this.notify();
    return prompt;
  }

  /** Starts a workflow for a root prompt that does not have one yet. */
  async startWorkflowFor(id: string, initialPhaseOrderIndex = 0): Promise<Prompt> {
    const prompt = this.require(id);
    if (prompt.parentPromptId) {
      throw new Error("Prompts filhos não possuem workflow próprio.");
    }
    if (prompt.workflow) {
      throw new Error("O prompt já possui workflow.");
    }
    const now = new Date().toISOString();
    prompt.workflow = startWorkflow(this.settings.phaseTemplate, now, initialPhaseOrderIndex);
    prompt.updatedAt = now;
    await this.persist(prompt);
    this.notify();
    return prompt;
  }

  /** Deletes the prompt and its children. */
  async delete(id: string): Promise<void> {
    const prompt = this.require(id);
    const children = this.listChildren(prompt.id);
    for (const child of children) {
      await this.delete(child.id);
    }
    this.prompts.delete(id);
    await fs.rm(this.promptDir(id), { recursive: true, force: true });
    this.notify();
  }

  /** Re-reads content from prompt.md when edited directly in the editor. */
  async syncContentFromDisk(id: string): Promise<Prompt | undefined> {
    const prompt = this.get(id);
    if (!prompt) {
      return undefined;
    }
    const content = await readTextFile(this.promptMarkdownPath(id));
    if (content === undefined || content === prompt.content) {
      return prompt;
    }
    return this.update(id, { content });
  }
}
