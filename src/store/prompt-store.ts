/**
 * File-backed prompt store: Sobek's replacement for Thoth's PostgreSQL + EF
 * persistence, scoped to the open workspace.
 *
 * Layout under `<workspace>/.sobek/`:
 *   settings.json                 — workspace-level settings (phase template, AI context flag)
 *   prompts/<id>/meta.json        — prompt metadata, workflow snapshot and timeline
 *   prompts/<id>/prompt.md        — current Markdown content
 *   prompts/<id>/versions.json    — immutable version snapshots
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { newId } from "../lib/ids";
import { parseMentions, resolveMentionPath } from "../core/mentions";
import type {
  FileReference,
  LinkedPlan,
  Prompt,
  PromptKind,
  PromptStatus,
  PromptVersion,
  TargetAgent,
} from "../core/prompt";
import { findTemplate } from "../core/templates";
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
  private loaded = false;

  constructor(private readonly workspaceRoot: string) {}

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

  onDidChange(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    this.settings = { ...DEFAULT_SETTINGS, ...stored };

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
      const content = (await readTextFile(this.promptMarkdownPath(id))) ?? "";
      this.prompts.set(id, { ...meta, content });
    }
    this.loaded = true;
    this.notify();
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
    const normalized = path.resolve(filePath);
    for (const prompt of this.prompts.values()) {
      if (path.resolve(this.promptMarkdownPath(prompt.id)) === normalized) {
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
      const template = findTemplate(input.sourceTemplateKey);
      if (template && parent.workflow) {
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
    const now = new Date().toISOString();
    prompt.status = status;
    prompt.currentVersion += 1;
    prompt.updatedAt = now;
    await this.persist(prompt);
    await this.appendVersion(prompt, "Status changed");
    this.notify();
    return prompt;
  }

  async setLinkedPlan(id: string, plan: LinkedPlan | undefined): Promise<Prompt> {
    const prompt = this.require(id);
    prompt.linkedPlan = plan;
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
