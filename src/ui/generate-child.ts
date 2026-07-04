import * as vscode from "vscode";
import * as path from "node:path";
import type { Prompt } from "../core/prompt";
import {
  findTemplate,
  getTemplatesInDisplayOrder,
  renderPromptDraft,
  templateRequiresPullRequest,
  type PromptTemplateDefinition,
} from "../core/templates";
import type { PromptStore } from "../store/prompt-store";
import { ChildPromptPreviewProvider } from "./child-preview";
import type { PromptTreeItem } from "./tree";

type PromptRef = string | PromptTreeItem | undefined;

function resolvePromptId(ref: PromptRef): string | undefined {
  return typeof ref === "string" ? ref : ref?.prompt.id;
}

async function pickPlanFile(workspaceRoot: string): Promise<vscode.Uri | undefined> {
  const files = await vscode.workspace.findFiles(
    "**/*.md",
    "{**/node_modules/**,**/.sobek/**,**/.git/**,**/dist/**,**/build/**}",
    500
  );
  if (files.length === 0) {
    void vscode.window.showWarningMessage("Nenhum arquivo Markdown encontrado no workspace.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    files
      .map((uri) => ({
        label: path.basename(uri.fsPath),
        description: path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/"),
        uri,
      }))
      .sort((a, b) => a.description.localeCompare(b.description)),
    { placeHolder: "Selecione o plano Markdown (ex.: plano gerado pelo Claude Code)" }
  );
  return picked?.uri;
}

async function ensureLinkedPlan(store: PromptStore, prompt: Prompt): Promise<Prompt | undefined> {
  if (prompt.linkedPlan) {
    return prompt;
  }
  const answer = await vscode.window.showInformationMessage(
    "Este prompt ainda não tem um plano vinculado. Prompts filhos são gerados a partir de um plano Markdown.",
    "Vincular plano"
  );
  if (answer !== "Vincular plano") {
    return undefined;
  }
  const uri = await pickPlanFile(store.root);
  if (!uri) {
    return undefined;
  }
  const relativePath = path.relative(store.root, uri.fsPath).replace(/\\/g, "/");
  return store.setLinkedPlan(prompt.id, {
    relativePath,
    displayName: path.basename(uri.fsPath),
  });
}

async function collectInputs(
  template: PromptTemplateDefinition,
  storedPullRequest: string | undefined
): Promise<{ pullRequestInput?: string; inputs: Record<string, string> } | undefined> {
  const inputs: Record<string, string> = {};
  let pullRequestInput: string | undefined;

  if (templateRequiresPullRequest(template.key)) {
    const prDefinition = template.inputs.find((input) => input.key === "pullRequest");
    pullRequestInput = await vscode.window.showInputBox({
      prompt: prDefinition?.helpText ?? "Informe o número ou link da PR.",
      placeHolder: prDefinition?.placeholder ?? "#123 ou URL da PR",
      value: storedPullRequest,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? "A PR é obrigatória." : undefined),
    });
    if (pullRequestInput === undefined) {
      return undefined;
    }
  }

  for (const input of template.inputs) {
    if (input.key === "pullRequest") {
      continue;
    }
    if (input.multiline) {
      const source = await vscode.window.showQuickPick(
        [
          {
            label: "$(clippy) Colar da área de transferência",
            description: input.placeholder,
            action: "clipboard" as const,
          },
          { label: "$(edit) Digitar manualmente", action: "type" as const },
        ],
        { placeHolder: `${input.label}: como fornecer o conteúdo?`, ignoreFocusOut: true }
      );
      if (!source) {
        return undefined;
      }
      let value: string | undefined;
      if (source.action === "clipboard") {
        value = (await vscode.env.clipboard.readText()).trim();
        if (!value) {
          void vscode.window.showWarningMessage("A área de transferência está vazia.");
          return undefined;
        }
      } else {
        value = await vscode.window.showInputBox({
          prompt: input.placeholder,
          ignoreFocusOut: true,
          validateInput: (candidate) =>
            input.required && candidate.trim().length === 0
              ? `O campo "${input.label}" é obrigatório.`
              : undefined,
        });
        if (value === undefined) {
          return undefined;
        }
      }
      inputs[input.key] = value;
    } else {
      const value = await vscode.window.showInputBox({
        prompt: input.helpText || input.label,
        placeHolder: input.placeholder,
        ignoreFocusOut: true,
        validateInput: (candidate) =>
          input.required && candidate.trim().length === 0
            ? `O campo "${input.label}" é obrigatório.`
            : undefined,
      });
      if (value === undefined) {
        return undefined;
      }
      inputs[input.key] = value;
    }
  }

  return { pullRequestInput, inputs };
}

export type ChildCreatedListener = (child: Prompt, parent: Prompt) => void | Promise<void>;

export function registerGenerateChildCommands(
  context: vscode.ExtensionContext,
  store: PromptStore,
  onChildCreated?: ChildCreatedListener
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sobek.linkPlan", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      const uri = await pickPlanFile(store.root);
      if (!uri) {
        return;
      }
      const relativePath = path.relative(store.root, uri.fsPath).replace(/\\/g, "/");
      await store.setLinkedPlan(id, { relativePath, displayName: path.basename(uri.fsPath) });
      void vscode.window.showInformationMessage(`Plano vinculado: ${relativePath}`);
    }),

    vscode.commands.registerCommand("sobek.unlinkPlan", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      await store.setLinkedPlan(id, undefined);
    }),

    vscode.commands.registerCommand("sobek.generateChildPrompt", async (ref: PromptRef) => {
      const id = resolvePromptId(ref);
      if (!id) {
        return;
      }
      let parent = store.require(id);
      if (parent.parentPromptId) {
        void vscode.window.showWarningMessage("Prompts filhos não geram outros filhos.");
        return;
      }
      if (parent.status === "Archived") {
        void vscode.window.showWarningMessage("Prompt arquivado não gera prompts filhos.");
        return;
      }

      const withPlan = await ensureLinkedPlan(store, parent);
      if (!withPlan?.linkedPlan) {
        return;
      }
      parent = withPlan;
      const plan = parent.linkedPlan!;

      const pickedTemplate = await vscode.window.showQuickPick(
        getTemplatesInDisplayOrder().map((template) => ({
          label: template.isReReview ? `$(sync) ${template.displayName}` : template.displayName,
          description: template.description,
          key: template.key,
        })),
        { placeHolder: "Template do prompt filho" }
      );
      if (!pickedTemplate) {
        return;
      }
      const template = findTemplate(pickedTemplate.key)!;

      const collected = await collectInputs(template, plan.pullRequestReference);
      if (!collected) {
        return;
      }

      let draft;
      try {
        draft = renderPromptDraft({
          template,
          planAbsolutePath: path.join(store.root, plan.relativePath),
          planDisplayName: plan.displayName,
          parentPromptContent: parent.content,
          pullRequestInput: collected.pullRequestInput,
          storedPullRequestReference: plan.pullRequestReference,
          inputs: collected.inputs,
        });
      } catch (error) {
        void vscode.window.showErrorMessage((error as Error).message);
        return;
      }

      const title = await vscode.window.showInputBox({
        prompt: "Título do prompt filho",
        value: draft.title,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim().length === 0 ? "Informe um título." : undefined),
      });
      if (!title) {
        return;
      }

      const child = await store.create({
        title: title.trim(),
        content: draft.content,
        parentPromptId: parent.id,
        targetAgent: template.defaultTargetAgent,
        kind: template.defaultKind,
        status: "Draft",
        sourceTemplateKey: template.key,
      });

      if (collected.pullRequestInput?.trim()) {
        await store.setPullRequestReference(parent.id, collected.pullRequestInput.trim());
      }

      // Stay in the parent's context: read-only preview + copy, no navigation
      // to a child edit surface (Thoth product rule).
      const uri = ChildPromptPreviewProvider.uriFor(child.id, child.title);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(document, "markdown");
      await vscode.window.showTextDocument(document, { preview: true });

      const updatedParent = store.require(parent.id);
      const phase = updatedParent.workflow?.currentPhaseName;
      const action = await vscode.window.showInformationMessage(
        phase
          ? `Prompt filho criado. Tarefa avançou para "${phase}".`
          : "Prompt filho criado.",
        "Copiar prompt"
      );
      if (action === "Copiar prompt") {
        await vscode.env.clipboard.writeText(child.content);
      }

      await onChildCreated?.(child, updatedParent);
    })
  );
}
