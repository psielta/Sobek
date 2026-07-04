import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptStore } from "./prompt-store";

let root: string;
let store: PromptStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sobek-store-"));
  store = new PromptStore(root);
  await store.load();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("create", () => {
  it("starts a workflow on phase 0 for root prompts", async () => {
    const prompt = await store.create({ title: "Tarefa", content: "# md" });
    expect(prompt.workflow?.status).toBe("Active");
    expect(prompt.workflow?.currentPhaseName).toBe("Engenharia de prompt");
    expect(prompt.workflow?.currentActor).toBe("Human");
    expect(prompt.currentVersion).toBe(1);
    const versions = await store.getVersions(prompt.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, changeNote: "Created" });
  });

  it("does not start a workflow for archived roots or children", async () => {
    const archived = await store.create({ title: "Arquivado", content: "", status: "Archived" });
    expect(archived.workflow).toBeUndefined();
    const parent = await store.create({ title: "Pai", content: "" });
    const child = await store.create({ title: "Filho", content: "", parentPromptId: parent.id });
    expect(child.workflow).toBeUndefined();
  });

  it("advances the parent workflow when a child comes from a template", async () => {
    const parent = await store.create({ title: "Pai", content: "" });
    await store.create({
      title: "Revisar plano: p",
      content: "...",
      parentPromptId: parent.id,
      sourceTemplateKey: "ReviewPlan",
    });
    const reloaded = store.require(parent.id);
    expect(reloaded.workflow?.currentPhaseName).toBe("Revisão do plano");
    expect(reloaded.workflow?.events.at(-1)?.note).toBe('Gerado via "Revisar plano"');
  });

  it("extracts file references from @mentions in the content", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "x");
    const prompt = await store.create({ title: "T", content: "veja @src/a.ts e @nao/existe.md" });
    expect(prompt.fileReferences).toEqual([
      { relativePath: "src/a.ts", exists: true },
      { relativePath: "nao/existe.md", exists: false },
    ]);
  });
});

describe("update and versioning", () => {
  it("increments the version on updates and status changes", async () => {
    const prompt = await store.create({ title: "T", content: "v1" });
    await store.update(prompt.id, { content: "v2" });
    await store.updateStatus(prompt.id, "Ready");
    const versions = await store.getVersions(prompt.id);
    expect(versions.map((version) => version.changeNote)).toEqual([
      "Created",
      "Updated",
      "Status changed",
    ]);
    expect(store.require(prompt.id).currentVersion).toBe(3);
    expect(versions[2].status).toBe("Ready");
  });
});

describe("listing", () => {
  it("listRoots excludes children; listChildren returns them", async () => {
    const parent = await store.create({ title: "Pai", content: "" });
    await store.create({ title: "Filho", content: "", parentPromptId: parent.id });
    expect(store.listRoots().map((prompt) => prompt.title)).toEqual(["Pai"]);
    expect(store.listChildren(parent.id).map((prompt) => prompt.title)).toEqual(["Filho"]);
  });
});

describe("persistence round-trip", () => {
  it("reloads prompts, workflow and content from disk", async () => {
    const created = await store.create({ title: "Persistente", content: "# corpo" });
    const fresh = new PromptStore(root);
    await fresh.load();
    const reloaded = fresh.require(created.id);
    expect(reloaded.title).toBe("Persistente");
    expect(reloaded.content).toBe("# corpo");
    expect(reloaded.workflow?.phases).toHaveLength(10);
  });
});

describe("delete", () => {
  it("removes children recursively", async () => {
    const parent = await store.create({ title: "Pai", content: "" });
    await store.create({ title: "Filho", content: "", parentPromptId: parent.id });
    await store.delete(parent.id);
    expect(store.listAll()).toHaveLength(0);
  });
});

describe("linked plan", () => {
  it("stores plan pointers and PR references", async () => {
    const prompt = await store.create({ title: "T", content: "" });
    await store.setLinkedPlan(prompt.id, { relativePath: "docs/plan.md", displayName: "plan.md" });
    await store.setPullRequestReference(prompt.id, "#42");
    expect(store.require(prompt.id).linkedPlan).toEqual({
      relativePath: "docs/plan.md",
      displayName: "plan.md",
      pullRequestReference: "#42",
    });
  });
});
