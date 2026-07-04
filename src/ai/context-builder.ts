import * as vscode from "vscode";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { Prompt } from "../core/prompt";
import { WORKFLOW_ACTOR_LABELS } from "../core/workflow";
import type { PromptStore } from "../store/prompt-store";
import {
  buildGitContextBlock,
  buildLinkedPlanBlock,
  buildMentionedFilesBlock,
  buildParentPromptBlock,
  buildSelectedFilesBlock,
  buildWorkflowStateBlock,
  MAX_CONTEXT_FILE_BYTES,
  MAX_TOTAL_CONTEXT_CHARS,
  type NamedContent,
} from "./instructions";

const execFileAsync = promisify(execFile);

/** Tracks the total-size budget shared by all prompt-derived context blocks. */
class ContextBudget {
  private used = 0;

  fits(content: string): boolean {
    return this.used + content.length <= MAX_TOTAL_CONTEXT_CHARS;
  }

  take(content: string): void {
    this.used += content.length;
  }
}

async function readBounded(
  filePath: string,
  budget: ContextBudget
): Promise<string | undefined> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size === 0 || stats.size > MAX_CONTEXT_FILE_BYTES) {
      return undefined;
    }
    const content = (await fs.readFile(filePath, "utf8")).trim();
    if (!content || !budget.fits(content)) {
      return undefined;
    }
    budget.take(content);
    return content;
  } catch {
    return undefined;
  }
}

/** Resolves a workspace-relative path, rejecting escapes — same rule as mentions. */
function resolveInside(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
}

export async function readSelectedFiles(
  root: string,
  relativePaths: string[],
  budget: ContextBudget = new ContextBudget()
): Promise<NamedContent[]> {
  const seen = new Set<string>();
  const files: NamedContent[] = [];
  for (const relative of relativePaths) {
    const key = relative.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const resolved = resolveInside(root, relative);
    if (!resolved) {
      continue;
    }
    const content = await readBounded(resolved, budget);
    if (content) {
      files.push({ name: relative.replace(/\\/g, "/"), content });
    }
  }
  return files;
}

async function gitContext(root: string): Promise<string | undefined> {
  try {
    const [branch, log] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }),
      execFileAsync("git", ["log", "--oneline", "-10"], { cwd: root }),
    ]);
    const commits = log.stdout.trim().split(/\r?\n/).filter(Boolean);
    return buildGitContextBlock(branch.stdout.trim(), commits);
  } catch {
    // Not a git repository or git unavailable — never fail the AI call.
    return undefined;
  }
}

export interface PromptContextOptions {
  /** Selected context file paths (workspace-relative), refine flow only. */
  contextFiles?: string[];
}

interface AiContextConfig {
  includeMentionedFiles: boolean;
  includeLinkedPlan: boolean;
  includeParentPrompt: boolean;
  includeWorkflowContext: boolean;
  includeGitContext: boolean;
}

function readConfig(): AiContextConfig {
  const config = vscode.workspace.getConfiguration("sobek.ai");
  return {
    includeMentionedFiles: config.get<boolean>("includeMentionedFiles", true),
    includeLinkedPlan: config.get<boolean>("includeLinkedPlan", true),
    includeParentPrompt: config.get<boolean>("includeParentPrompt", true),
    includeWorkflowContext: config.get<boolean>("includeWorkflowContext", true),
    includeGitContext: config.get<boolean>("includeGitContext", false),
  };
}

/**
 * Assembles the prompt-derived context blocks (beyond the workspace README/
 * CLAUDE/AGENT context): selected files, @mentioned files, linked plan,
 * parent prompt, workflow state and git state. All file reads share a single
 * size budget so the system instruction stays bounded.
 */
export async function buildPromptContext(
  store: PromptStore,
  prompt: Prompt | undefined,
  options: PromptContextOptions = {}
): Promise<string | undefined> {
  const config = readConfig();
  const budget = new ContextBudget();
  const blocks: string[] = [];
  const root = store.root;

  if (options.contextFiles && options.contextFiles.length > 0) {
    const files = await readSelectedFiles(root, options.contextFiles, budget);
    const block = buildSelectedFilesBlock(files);
    if (block) {
      blocks.push(block);
    }
  }

  if (prompt) {
    if (config.includeMentionedFiles && prompt.fileReferences.length > 0) {
      const paths = prompt.fileReferences
        .filter((reference) => reference.exists)
        .map((reference) => reference.relativePath);
      const files = await readSelectedFiles(root, paths, budget);
      const block = buildMentionedFilesBlock(files);
      if (block) {
        blocks.push(block);
      }
    }

    if (config.includeLinkedPlan && prompt.linkedPlan) {
      const planPath = path.resolve(root, prompt.linkedPlan.path);
      const content = await readBounded(planPath, budget);
      if (content) {
        const block = buildLinkedPlanBlock(prompt.linkedPlan.displayName, content);
        if (block) {
          blocks.push(block);
        }
      }
    }

    if (config.includeParentPrompt && prompt.parentPromptId) {
      const parent = store.get(prompt.parentPromptId);
      if (parent?.content.trim() && budget.fits(parent.content)) {
        budget.take(parent.content);
        const block = buildParentPromptBlock(parent.content);
        if (block) {
          blocks.push(block);
        }
      }
    }

    // Child prompts read the parent's workflow — the child never owns one.
    const workflowOwner = prompt.parentPromptId ? store.get(prompt.parentPromptId) : prompt;
    const workflow = workflowOwner?.workflow;
    if (config.includeWorkflowContext && workflow) {
      const recentNotes = workflow.events
        .filter((event) => event.note)
        .slice(-5)
        .map((event) => event.note as string);
      blocks.push(
        buildWorkflowStateBlock({
          phaseName: workflow.currentPhaseName,
          actorLabel: workflow.currentActor
            ? WORKFLOW_ACTOR_LABELS[workflow.currentActor]
            : undefined,
          status: workflow.status,
          iteration: workflow.currentPhaseIteration,
          recentNotes,
        })
      );
    }
  }

  if (config.includeGitContext) {
    const block = await gitContext(root);
    if (block) {
      blocks.push(block);
    }
  }

  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
