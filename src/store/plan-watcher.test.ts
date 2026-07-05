import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanWatcherManager } from "./plan-watcher";
import { PromptStore } from "./prompt-store";

let root: string;
let store: PromptStore;
let manager: PlanWatcherManager;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sobek-plan-watcher-"));
  store = new PromptStore(root);
  await store.load();
  manager = new PlanWatcherManager(store, 50);
});

afterEach(async () => {
  manager.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

async function createLinkedPrompt(planContent = "# v1"): Promise<string> {
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "plan.md"), planContent, "utf8");
  const prompt = await store.create({ title: "T", content: "" });
  await store.setLinkedPlan(prompt.id, { path: "docs/plan.md", displayName: "plan.md" });
  return prompt.id;
}

describe("sync", () => {
  it("watches active root prompts with a linked plan, and only those", async () => {
    const linked = await createLinkedPrompt();
    const bare = await store.create({ title: "Sem plano", content: "" });
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([linked]);
    expect(manager.watchedPromptIds()).not.toContain(bare.id);
  });

  it("stops watching on pause, archive and unlink", async () => {
    const id = await createLinkedPrompt();
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([id]);

    await store.setPlanMonitoringPaused(id, true);
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([]);

    await store.setPlanMonitoringPaused(id, false);
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([id]);

    await store.updateStatus(id, "Archived");
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([]);
  });

  it("captures changes made while unwatched when the watch starts", async () => {
    const id = await createLinkedPrompt("# v1");
    // Edit happens with no watcher attached (e.g. VS Code was closed).
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# editado offline", "utf8");
    manager.sync();
    await expect
      .poll(async () => (await store.getPlanVersions(id)).length, { timeout: 5000 })
      .toBe(2);
    const versions = await store.getPlanVersions(id);
    expect(versions.at(-1)).toMatchObject({ content: "# editado offline", origin: "Watcher" });
  });

  it("tolerates plans whose directory does not exist", async () => {
    const prompt = await store.create({ title: "T", content: "" });
    await store.setLinkedPlan(prompt.id, {
      path: "nao/existe/plan.md",
      displayName: "plan.md",
    });
    manager.sync();
    expect(manager.watchedPromptIds()).toEqual([]);
  });
});

describe("checkNow", () => {
  it("captures a Watcher version and notifies the listener", async () => {
    const id = await createLinkedPrompt("# v1");
    const captured: number[] = [];
    manager.onDidCaptureVersion = (_, version) => captured.push(version.versionNumber);
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# v2", "utf8");
    const version = await manager.checkNow(id);
    expect(version).toMatchObject({ versionNumber: 2, origin: "Watcher" });
    expect(captured).toEqual([2]);
    // Unchanged content is a no-op.
    expect(await manager.checkNow(id)).toBeUndefined();
  });
});

describe("file events", () => {
  it("captures a version when the plan file changes on disk", async () => {
    const id = await createLinkedPrompt("# v1");
    manager.sync();
    // Let the initial reconcile settle before the real edit.
    await expect
      .poll(async () => (await store.getPlanVersions(id)).length, { timeout: 5000 })
      .toBe(1);

    await fs.writeFile(path.join(root, "docs", "plan.md"), "# v2 via fs event", "utf8");
    await expect
      .poll(async () => (await store.getPlanVersions(id)).length, { timeout: 10_000 })
      .toBe(2);
    const versions = await store.getPlanVersions(id);
    expect(versions.at(-1)).toMatchObject({ content: "# v2 via fs event", origin: "Watcher" });
  }, 15_000);
});
