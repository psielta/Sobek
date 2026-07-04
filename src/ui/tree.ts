import * as vscode from "vscode";
import type { Prompt } from "../core/prompt";
import { isRootPrompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import { promptStatusLabel, targetAgentLabel } from "./labels";

/**
 * Sidebar tree: root prompts at the top level (the workspace listing never
 * shows children), each child prompt nested under its parent.
 */
export class PromptTreeProvider implements vscode.TreeDataProvider<PromptTreeItem> {
  private readonly emitter = new vscode.EventEmitter<PromptTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly store: PromptStore) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: PromptTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PromptTreeItem): PromptTreeItem[] {
    if (!element) {
      return this.store.listRoots().map((prompt) => this.buildItem(prompt));
    }
    return this.store.listChildren(element.prompt.id).map((prompt) => this.buildItem(prompt));
  }

  private buildItem(prompt: Prompt): PromptTreeItem {
    const isRoot = isRootPrompt(prompt);
    const hasChildren = isRoot && this.store.listChildren(prompt.id).length > 0;
    return new PromptTreeItem(prompt, isRoot, hasChildren);
  }
}

export class PromptTreeItem extends vscode.TreeItem {
  constructor(
    public readonly prompt: Prompt,
    isRoot: boolean,
    hasChildren: boolean
  ) {
    super(
      prompt.title || vscode.l10n.t("(untitled)"),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.id = prompt.id;
    // Faceted context value drives conditional inline actions (e.g. "link
    // plan" only when no plan is linked yet).
    this.contextValue = isRoot
      ? `sobekRootPrompt-${prompt.linkedPlan ? "plan" : "noplan"}`
      : "sobekChildPrompt";

    const statusLabel = promptStatusLabel(prompt.status);
    const agentLabel = targetAgentLabel(prompt.targetAgent);
    const phase = prompt.workflow?.currentPhaseName;
    this.description = isRoot
      ? [phase, statusLabel].filter(Boolean).join(" · ")
      : `${statusLabel} · ${agentLabel}`;

    this.tooltip = new vscode.MarkdownString(
      [
        `**${prompt.title || vscode.l10n.t("(untitled)")}**`,
        "",
        `- ${vscode.l10n.t("Status")}: ${statusLabel}`,
        `- ${vscode.l10n.t("Agent")}: ${agentLabel}`,
        `- ${vscode.l10n.t("Version")}: v${prompt.currentVersion}`,
        phase
          ? `- ${vscode.l10n.t("Phase")}: ${phase} (${
              prompt.workflow?.status === "Done" ? vscode.l10n.t("done") : vscode.l10n.t("active")
            })`
          : undefined,
        prompt.linkedPlan
          ? `- ${vscode.l10n.t("Plan")}: ${prompt.linkedPlan.displayName}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n")
    );

    // Ready prompts get a green icon so the status is visible at a glance.
    const readyColor =
      prompt.status === "Ready" ? new vscode.ThemeColor("charts.green") : undefined;
    if (prompt.status === "Archived") {
      this.iconPath = new vscode.ThemeIcon("archive", new vscode.ThemeColor("disabledForeground"));
    } else if (!isRoot) {
      this.iconPath = new vscode.ThemeIcon("git-branch", readyColor);
    } else {
      this.iconPath = new vscode.ThemeIcon(
        prompt.workflow?.status === "Done" ? "pass-filled" : "note",
        readyColor
      );
    }

    // Product rule from Thoth: clicking a child opens a read-only preview in
    // the parent's context, never the child's edit surface.
    this.command = isRoot
      ? { command: "sobek.openPrompt", title: "Abrir prompt", arguments: [prompt.id] }
      : { command: "sobek.openChildPrompt", title: "Abrir prompt filho", arguments: [prompt.id] };
  }
}
