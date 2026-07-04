import * as vscode from "vscode";
import type { Prompt } from "../core/prompt";
import type { PromptStore } from "../store/prompt-store";
import type { ManagedTerminal, TerminalManager } from "./manager";

const WORKSPACE_GROUP = "__workspace__";

export interface TerminalGroupNode {
  kind: "group";
  /** Root prompt id, or the workspace sentinel for prompt-less terminals. */
  groupId: string;
}

export interface TerminalLeafNode {
  kind: "terminal";
  entry: ManagedTerminal;
}

export type TerminalTreeNode = TerminalGroupNode | TerminalLeafNode;

/**
 * "Terminais" view: every Sobek terminal grouped by ROOT prompt — terminals
 * opened for child prompts appear under the parent with a "Filho" badge, and
 * opening the prompt from a child terminal always targets the parent (Thoth
 * product rule). Generic terminals live under a workspace group.
 */
export class TerminalsTreeProvider implements vscode.TreeDataProvider<TerminalTreeNode> {
  private readonly emitter = new vscode.EventEmitter<TerminalTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: PromptStore,
    private readonly manager: TerminalManager,
    context: vscode.ExtensionContext
  ) {
    context.subscriptions.push(this.manager.onDidChange(() => this.emitter.fire(undefined)));
    store.onDidChange(() => this.emitter.fire(undefined));
  }

  /** Root prompt that owns the group a terminal belongs to. */
  private groupIdFor(entry: ManagedTerminal): string {
    if (!entry.promptId) {
      return WORKSPACE_GROUP;
    }
    const prompt = this.store.get(entry.promptId);
    return prompt?.parentPromptId ?? entry.promptId;
  }

  getChildren(element?: TerminalTreeNode): TerminalTreeNode[] {
    const terminals = this.manager.list();
    if (!element) {
      const groups: string[] = [];
      for (const entry of terminals) {
        const groupId = this.groupIdFor(entry);
        if (!groups.includes(groupId)) {
          groups.push(groupId);
        }
      }
      // Workspace group last, like Thoth keeps prompt groups first.
      groups.sort((a, b) => Number(a === WORKSPACE_GROUP) - Number(b === WORKSPACE_GROUP));
      return groups.map((groupId) => ({ kind: "group", groupId }));
    }
    if (element.kind === "group") {
      return terminals
        .filter((entry) => this.groupIdFor(entry) === element.groupId)
        .map((entry) => ({ kind: "terminal", entry }));
    }
    return [];
  }

  getTreeItem(node: TerminalTreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      if (node.groupId === WORKSPACE_GROUP) {
        const item = new vscode.TreeItem(
          vscode.l10n.t("Workspace terminals"),
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon("folder");
        item.contextValue = "sobekTerminalWorkspaceGroup";
        return item;
      }
      const prompt = this.store.get(node.groupId);
      const item = new vscode.TreeItem(
        prompt?.title || vscode.l10n.t("(untitled)"),
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon("note");
      item.contextValue = "sobekTerminalGroup";
      if (prompt?.status === "Archived") {
        item.description = vscode.l10n.t("Archived");
        item.iconPath = new vscode.ThemeIcon("archive", new vscode.ThemeColor("disabledForeground"));
      }
      return item;
    }

    const { entry } = node;
    const item = new vscode.TreeItem(entry.terminal.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(entry.agent ? "robot" : "terminal");
    item.contextValue = "sobekTerminal";
    const prompt: Prompt | undefined = entry.promptId ? this.store.get(entry.promptId) : undefined;
    if (prompt?.parentPromptId) {
      item.description = `${vscode.l10n.t("Child")} · ${prompt.title || vscode.l10n.t("(untitled)")}`;
    } else if (entry.agent) {
      item.description = entry.agent;
    }
    item.command = {
      command: "sobek.revealTerminal",
      title: vscode.l10n.t("Show terminal"),
      arguments: [node],
    };
    return item;
  }
}

export function registerTerminalsView(
  context: vscode.ExtensionContext,
  store: PromptStore,
  manager: TerminalManager
): void {
  const provider = new TerminalsTreeProvider(store, manager, context);
  context.subscriptions.push(
    vscode.window.createTreeView("sobekTerminals", { treeDataProvider: provider }),

    vscode.commands.registerCommand("sobek.revealTerminal", (node: TerminalTreeNode) => {
      if (node?.kind === "terminal") {
        node.entry.terminal.show();
      }
    }),

    vscode.commands.registerCommand("sobek.killTerminal", (node: TerminalTreeNode) => {
      if (node?.kind === "terminal") {
        node.entry.terminal.dispose();
      }
    }),

    vscode.commands.registerCommand("sobek.openTerminalPrompt", async (node: TerminalTreeNode) => {
      // Always open the ROOT prompt, even from a child's terminal.
      let promptId: string | undefined;
      if (node?.kind === "group" && node.groupId !== WORKSPACE_GROUP) {
        promptId = node.groupId;
      } else if (node?.kind === "terminal" && node.entry.promptId) {
        const prompt = store.get(node.entry.promptId);
        promptId = prompt?.parentPromptId ?? prompt?.id;
      }
      if (promptId) {
        await vscode.commands.executeCommand("sobek.openPrompt", promptId);
      }
    })
  );
}
