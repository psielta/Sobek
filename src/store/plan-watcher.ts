/**
 * Watches linked plan files and snapshots a version on every content change —
 * the extension-host counterpart of Thoth's linked document watcher (there the
 * backend watched the file and pushed versions to the browser via SignalR).
 *
 * Rules ported from Thoth:
 *   - archived prompts stop monitoring their linked plan;
 *   - monitoring can be paused/resumed per prompt;
 *   - every distinct content is kept as an immutable version.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LinkedPlanVersion, Prompt } from "../core/prompt";
import type { PromptStore } from "./prompt-store";

interface WatchEntry {
  /** Absolute path of the watched plan file. */
  planPath: string;
  fileName: string;
  watcher: fs.FSWatcher;
  timer?: NodeJS.Timeout;
}

function sameFileName(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class PlanWatcherManager {
  private readonly entries = new Map<string, WatchEntry>();
  private disposed = false;

  /** Fired after the watcher captures a new plan version (UI feedback hook). */
  onDidCaptureVersion?: (promptId: string, version: LinkedPlanVersion) => void;

  constructor(
    private readonly store: PromptStore,
    private readonly debounceMs = 500
  ) {}

  /** Prompt ids currently being watched (exposed for tests/diagnostics). */
  watchedPromptIds(): string[] {
    return [...this.entries.keys()];
  }

  private shouldWatch(prompt: Prompt): boolean {
    return (
      !prompt.parentPromptId &&
      prompt.status !== "Archived" &&
      !!prompt.linkedPlan &&
      !prompt.linkedPlan.monitoringPaused
    );
  }

  /**
   * Reconciles watchers with the store state. Cheap and idempotent — call it
   * on every store change. Newly watched plans get an immediate capture so
   * edits made while unwatched (VS Code closed, monitoring paused) are not
   * lost.
   */
  sync(): void {
    if (this.disposed) {
      return;
    }
    const desired = new Map<string, string>();
    for (const prompt of this.store.listAll()) {
      if (this.shouldWatch(prompt)) {
        desired.set(prompt.id, this.store.resolvePlanPath(prompt.linkedPlan!));
      }
    }

    for (const [promptId, entry] of this.entries) {
      if (desired.get(promptId) !== entry.planPath) {
        this.drop(promptId);
      }
    }

    for (const [promptId, planPath] of desired) {
      if (!this.entries.has(promptId)) {
        this.add(promptId, planPath);
      }
    }
  }

  private add(promptId: string, planPath: string): void {
    const fileName = path.basename(planPath);
    let watcher: fs.FSWatcher;
    try {
      // Watch the containing directory: editors save via atomic rename, which
      // detaches a watch placed on the file itself.
      watcher = fs.watch(path.dirname(planPath), (_eventType, changed) => {
        if (changed === null || sameFileName(changed, fileName)) {
          this.scheduleCheck(promptId);
        }
      });
    } catch {
      // Directory missing/inaccessible — nothing to watch until it reappears.
      return;
    }
    watcher.on("error", () => this.drop(promptId));
    this.entries.set(promptId, { planPath, fileName, watcher });
    void this.checkNow(promptId);
  }

  private drop(promptId: string): void {
    const entry = this.entries.get(promptId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.watcher.close();
    this.entries.delete(promptId);
  }

  private scheduleCheck(promptId: string): void {
    const entry = this.entries.get(promptId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.checkNow(promptId);
    }, this.debounceMs);
  }

  /** Captures a version if the plan content changed since the last snapshot. */
  async checkNow(promptId: string): Promise<LinkedPlanVersion | undefined> {
    if (this.disposed || !this.store.get(promptId)) {
      return undefined;
    }
    try {
      const version = await this.store.capturePlanVersion(promptId, "Watcher");
      if (version) {
        this.onDidCaptureVersion?.(promptId, version);
      }
      return version;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const promptId of [...this.entries.keys()]) {
      this.drop(promptId);
    }
  }
}
