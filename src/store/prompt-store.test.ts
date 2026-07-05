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

describe("custom templates", () => {
  const TEMPLATE = `---
name: Revisão de segurança
targetAgent: Codex
targetPhaseRole: CodeReview
---
Audite o plano "{AbsolutePath}".
`;

  it("loads workspace templates and resolves custom keys", async () => {
    await fs.mkdir(path.join(root, ".sobek", "templates"), { recursive: true });
    await fs.writeFile(path.join(root, ".sobek", "templates", "seguranca.md"), TEMPLATE, "utf8");
    await store.reloadCustomTemplates();
    expect(store.getCustomTemplates().map((template) => template.key)).toEqual([
      "custom:seguranca",
    ]);
    expect(store.resolveTemplate("custom:seguranca")?.displayName).toBe("Revisão de segurança");
    expect(store.resolveTemplate("ReviewPlan")?.displayName).toBe("Revisar plano");
  });

  it("advances the parent workflow for custom templates with a role", async () => {
    await fs.mkdir(path.join(root, ".sobek", "templates"), { recursive: true });
    await fs.writeFile(path.join(root, ".sobek", "templates", "seguranca.md"), TEMPLATE, "utf8");
    await fs.writeFile(
      path.join(root, ".sobek", "templates", "sem-fase.md"),
      "---\nname: Sem fase\n---\ncorpo",
      "utf8"
    );
    await store.reloadCustomTemplates();

    const parent = await store.create({ title: "Pai", content: "" });
    await store.create({
      title: "Filho custom",
      content: "...",
      parentPromptId: parent.id,
      sourceTemplateKey: "custom:seguranca",
    });
    expect(store.require(parent.id).workflow?.currentPhaseName).toBe("Revisão de código");

    const before = store.require(parent.id).workflow?.currentPhaseName;
    await store.create({
      title: "Filho sem fase",
      content: "...",
      parentPromptId: parent.id,
      sourceTemplateKey: "custom:sem-fase",
    });
    expect(store.require(parent.id).workflow?.currentPhaseName).toBe(before);
  });

  it("collects parse errors without failing the load", async () => {
    await fs.mkdir(path.join(root, ".sobek", "templates"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".sobek", "templates", "quebrado.md"),
      "sem frontmatter",
      "utf8"
    );
    await store.reloadCustomTemplates();
    expect(store.getCustomTemplates()).toHaveLength(0);
    expect(store.getCustomTemplateErrors()[0]?.slug).toBe("quebrado");
  });
});

describe("linked plan", () => {
  it("stores plan pointers (relative or absolute) and PR references", async () => {
    const prompt = await store.create({ title: "T", content: "" });
    await store.setLinkedPlan(prompt.id, { path: "docs/plan.md", displayName: "plan.md" });
    await store.setPullRequestReference(prompt.id, "#42");
    expect(store.require(prompt.id).linkedPlan).toEqual({
      path: "docs/plan.md",
      displayName: "plan.md",
      pullRequestReference: "#42",
    });
    await store.setLinkedPlan(prompt.id, {
      path: "C:\\planos\\fora-do-workspace.md",
      displayName: "fora-do-workspace.md",
    });
    expect(store.require(prompt.id).linkedPlan?.path).toBe("C:\\planos\\fora-do-workspace.md");
  });

  it("migrates the legacy relativePath field on load", async () => {
    const prompt = await store.create({ title: "T", content: "" });
    const metaPath = path.join(root, ".sobek", "prompts", prompt.id, "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    meta.linkedPlan = { relativePath: "docs/legado.md", displayName: "legado.md" };
    await fs.writeFile(metaPath, JSON.stringify(meta), "utf8");
    const fresh = new PromptStore(root);
    await fresh.load();
    expect(fresh.require(prompt.id).linkedPlan?.path).toBe("docs/legado.md");
  });
});

describe("linked plan versions", () => {
  async function linkPlan(content = "# v1"): Promise<string> {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "plan.md"), content, "utf8");
    const prompt = await store.create({ title: "T", content: "" });
    await store.setLinkedPlan(prompt.id, { path: "docs/plan.md", displayName: "plan.md" });
    return prompt.id;
  }

  it("captures version 1 when the plan is linked", async () => {
    const id = await linkPlan("# v1");
    const versions = await store.getPlanVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, content: "# v1", origin: "Linked" });
  });

  it("skips capture when the content is unchanged and appends when it changes", async () => {
    const id = await linkPlan("# v1");
    expect(await store.capturePlanVersion(id, "Watcher")).toBeUndefined();
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# v2", "utf8");
    const captured = await store.capturePlanVersion(id, "Watcher");
    expect(captured).toMatchObject({ versionNumber: 2, content: "# v2", origin: "Watcher" });
    expect(await store.getPlanVersions(id)).toHaveLength(2);
  });

  it("returns undefined when the plan file is missing", async () => {
    const id = await linkPlan();
    await fs.rm(path.join(root, "docs", "plan.md"));
    expect(await store.capturePlanVersion(id, "Manual")).toBeUndefined();
  });

  it("resets the history when linking a different file and clears it on unlink", async () => {
    const id = await linkPlan("# v1");
    await fs.writeFile(path.join(root, "docs", "outro.md"), "# outro", "utf8");
    await store.setLinkedPlan(id, { path: "docs/outro.md", displayName: "outro.md" });
    const versions = await store.getPlanVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, content: "# outro" });
    await store.setLinkedPlan(id, undefined);
    expect(await store.getPlanVersions(id)).toHaveLength(0);
  });

  it("keeps the history when re-linking the same path", async () => {
    const id = await linkPlan("# v1");
    await fs.writeFile(path.join(root, "docs", "plan.md"), "# v2", "utf8");
    await store.capturePlanVersion(id, "Watcher");
    await store.setLinkedPlan(id, { path: "docs/plan.md", displayName: "plan.md" });
    expect(await store.getPlanVersions(id)).toHaveLength(2);
  });

  it("persists the monitoring pause flag", async () => {
    const id = await linkPlan();
    await store.setPlanMonitoringPaused(id, true);
    expect(store.require(id).linkedPlan?.monitoringPaused).toBe(true);
    await store.setPlanMonitoringPaused(id, false);
    expect(store.require(id).linkedPlan?.monitoringPaused).toBeUndefined();
  });
});
