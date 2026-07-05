import * as vscode from "vscode";
import * as fs from "node:fs";
import type { LinkedPlanVersion, Prompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

export const PLAN_VERSION_SCHEME = "sobek-plan";

/**
 * Read-only snapshots of linked plan versions, served for previews and for
 * both sides of `vscode.diff` comparisons.
 */
export class PlanVersionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: PromptStore) {}

  static uriFor(promptId: string, versionNumber: number, displayName: string): vscode.Uri {
    const safeName = displayName.replace(/[\\/:*?"<>|#]/g, "_") || "plano.md";
    const label = safeName.endsWith(".md")
      ? `v${versionNumber} ${safeName}`
      : `v${versionNumber} ${safeName}.md`;
    return vscode.Uri.from({
      scheme: PLAN_VERSION_SCHEME,
      path: `/${promptId}/${versionNumber}/${label}`,
    });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [promptId, versionRaw] = uri.path.replace(/^\//, "").split("/");
    const versionNumber = Number(versionRaw);
    const versions = await this.store.getPlanVersions(promptId);
    const version = versions.find((entry) => entry.versionNumber === versionNumber);
    return version?.content ?? vscode.l10n.t("Plan version not found.");
  }
}

function originLabel(origin: LinkedPlanVersion["origin"]): string {
  switch (origin) {
    case "Linked":
      return vscode.l10n.t("captured on link");
    case "Watcher":
      return vscode.l10n.t("auto-captured");
    case "Manual":
      return vscode.l10n.t("captured manually");
  }
}

function resolvePromptId(ref: PromptRef): string | undefined {
  return typeof ref === "string" ? ref : ref?.prompt.id;
}

/** Palette fallback: pick among root prompts that have a linked plan. */
async function pickPromptWithPlan(store: PromptStore): Promise<string | undefined> {
  const candidates = store.listRoots().filter((prompt) => prompt.linkedPlan);
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("No prompt in this workspace has a linked plan.")
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((prompt) => ({
      label: prompt.title || vscode.l10n.t("(untitled)"),
      description: prompt.linkedPlan!.displayName,
      id: prompt.id,
    })),
    { placeHolder: vscode.l10n.t("Which prompt's plan?") }
  );
  return picked?.id;
}

async function requirePromptWithPlan(
  store: PromptStore,
  ref: PromptRef
): Promise<Prompt | undefined> {
  const id = resolvePromptId(ref) ?? (await pickPromptWithPlan(store));
  if (!id) {
    return undefined;
  }
  const prompt = store.require(id);
  if (!prompt.linkedPlan) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("This prompt has no linked plan yet.")
    );
    return undefined;
  }
  return prompt;
}

async function openPlanVersion(
  promptId: string,
  version: LinkedPlanVersion,
  displayName: string
): Promise<void> {
  const uri = PlanVersionContentProvider.uriFor(promptId, version.versionNumber, displayName);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(document, "markdown");
  await vscode.window.showTextDocument(document, { preview: true });
}

type VersionPick = vscode.QuickPickItem & {
  version?: LinkedPlanVersion;
  action?: "capture";
};

async function showVersionHistory(store: PromptStore, prompt: Prompt): Promise<void> {
  const plan = prompt.linkedPlan!;
  const versions = await store.getPlanVersions(prompt.id);
  const newestFirst = [...versions].reverse();

  const compareCurrentButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("diff"),
    tooltip: vscode.l10n.t("Compare with current plan file"),
  };
  const comparePreviousButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("git-compare"),
    tooltip: vscode.l10n.t("Compare with previous version"),
  };

  const items: VersionPick[] = [
    {
      label: `$(add) ${vscode.l10n.t("Capture current content as a version")}`,
      action: "capture",
    },
    {
      label: vscode.l10n.t("Versions"),
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...newestFirst.map((version) => ({
      label: `$(git-commit) v${version.versionNumber}`,
      description: `${new Date(version.capturedAt).toLocaleString()} · ${originLabel(version.origin)}`,
      detail:
        version.versionNumber === versions.at(-1)?.versionNumber
          ? vscode.l10n.t("Latest version — Enter opens the snapshot")
          : undefined,
      buttons:
        version.versionNumber > (versions[0]?.versionNumber ?? 1)
          ? [comparePreviousButton, compareCurrentButton]
          : [compareCurrentButton],
      version,
    })),
  ];

  const picker = vscode.window.createQuickPick<VersionPick>();
  picker.title = vscode.l10n.t('Plan versions — "{0}"', plan.displayName);
  picker.placeholder = vscode.l10n.t(
    "Enter opens a snapshot; use the buttons to compare versions"
  );
  picker.items = items;
  picker.matchOnDescription = true;

  picker.onDidTriggerItemButton(async (event) => {
    const version = event.item.version;
    if (!version) {
      return;
    }
    picker.hide();
    const versionUri = PlanVersionContentProvider.uriFor(
      prompt.id,
      version.versionNumber,
      plan.displayName
    );
    if (event.button === compareCurrentButton) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        versionUri,
        vscode.Uri.file(store.resolvePlanPath(plan)),
        vscode.l10n.t("{0}: v{1} ↔ current", plan.displayName, version.versionNumber)
      );
      return;
    }
    const previous = [...versions]
      .reverse()
      .find((entry) => entry.versionNumber < version.versionNumber);
    if (!previous) {
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      PlanVersionContentProvider.uriFor(prompt.id, previous.versionNumber, plan.displayName),
      versionUri,
      vscode.l10n.t(
        "{0}: v{1} ↔ v{2}",
        plan.displayName,
        previous.versionNumber,
        version.versionNumber
      )
    );
  });

  picker.onDidAccept(async () => {
    const picked = picker.selectedItems[0];
    picker.hide();
    if (!picked) {
      return;
    }
    if (picked.action === "capture") {
      await vscode.commands.executeCommand("sobek.capturePlanVersion", prompt.id);
      return;
    }
    if (picked.version) {
      await openPlanVersion(prompt.id, picked.version, plan.displayName);
    }
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}

export function registerPlanCommands(
  context: vscode.ExtensionContext,
  store: PromptStore
): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PLAN_VERSION_SCHEME,
      new PlanVersionContentProvider(store)
    ),

    vscode.commands.registerCommand("sobek.openLinkedPlan", async (ref: PromptRef) => {
      const prompt = await requirePromptWithPlan(store, ref);
      if (!prompt) {
        return;
      }
      const planPath = store.resolvePlanPath(prompt.linkedPlan!);
      if (!fs.existsSync(planPath)) {
        const relinkLabel = vscode.l10n.t("Link another plan");
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t("Plan file not found: {0}", planPath),
          relinkLabel
        );
        if (answer === relinkLabel) {
          await vscode.commands.executeCommand("sobek.linkPlan", prompt.id);
        }
        return;
      }
      const document = await vscode.workspace.openTextDocument(planPath);
      await vscode.window.showTextDocument(document);
    }),

    vscode.commands.registerCommand("sobek.planVersionHistory", async (ref: PromptRef) => {
      const prompt = await requirePromptWithPlan(store, ref);
      if (!prompt) {
        return;
      }
      await showVersionHistory(store, prompt);
    }),

    vscode.commands.registerCommand("sobek.capturePlanVersion", async (ref: PromptRef) => {
      const prompt = await requirePromptWithPlan(store, ref);
      if (!prompt) {
        return;
      }
      if (!fs.existsSync(store.resolvePlanPath(prompt.linkedPlan!))) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("Plan file not found: {0}", store.resolvePlanPath(prompt.linkedPlan!))
        );
        return;
      }
      const version = await store.capturePlanVersion(prompt.id, "Manual");
      void vscode.window.showInformationMessage(
        version
          ? vscode.l10n.t("Plan version v{0} captured.", version.versionNumber)
          : vscode.l10n.t("No changes since the last captured version.")
      );
    }),

    vscode.commands.registerCommand("sobek.pausePlanMonitoring", async (ref: PromptRef) => {
      const prompt = await requirePromptWithPlan(store, ref);
      if (!prompt) {
        return;
      }
      await store.setPlanMonitoringPaused(prompt.id, true);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Plan monitoring paused — file changes will not create versions.")
      );
    }),

    vscode.commands.registerCommand("sobek.resumePlanMonitoring", async (ref: PromptRef) => {
      const prompt = await requirePromptWithPlan(store, ref);
      if (!prompt) {
        return;
      }
      await store.setPlanMonitoringPaused(prompt.id, false);
      void vscode.window.showInformationMessage(vscode.l10n.t("Plan monitoring resumed."));
    })
  );
}
