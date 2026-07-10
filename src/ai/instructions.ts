/**
 * System instructions ported verbatim from Thoth's Application layer so the
 * extension keeps behavioural parity with the original backend.
 */

export const REFINE_SYSTEM_INSTRUCTION =
  "Você é um especialista em engenharia de prompts. " +
  "Otimize o prompt do usuário para clareza, completude e eficácia. " +
  "Escreva SEMPRE o prompt final em português (pt-BR), independentemente do idioma de entrada. " +
  "Responda APENAS com o prompt otimizado em Markdown compatível com TipTap " +
  "(use títulos, listas, negrito e code blocks; sem HTML). " +
  "Preserve menções @caminho/arquivo intactas. " +
  "Não adicione explicações, apenas o prompt melhorado.";

export const CHAT_SYSTEM_INSTRUCTION =
  "Você é um assistente especializado em engenharia de prompts para Claude Code e Codex. " +
  "Responda SEMPRE em português (pt-BR). " +
  "SEMPRE formate suas respostas em Markdown: use cabeçalhos, listas, negrito, itálico, " +
  "código com indicação de linguagem (```csharp, ```typescript, etc.) e tabelas quando adequado. " +
  "Para blocos de código, sempre especifique a linguagem. " +
  "Seja claro, direto e técnico.";

/**
 * Names read from the workspace root when AI context is enabled. Thoth reads
 * the first three; Sobek extends the list with other agent-convention files.
 */
export const WORKSPACE_CONTEXT_FILES = [
  "README.md",
  "CLAUDE.md",
  "AGENT.md",
  "AGENTS.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
] as const;

export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_CONTEXT_CHARS = 48_000;

export interface WorkspaceContextFile {
  name: string;
  content: string;
}

/** Builds the "Contexto do workspace" block appended to system instructions. */
export function buildWorkspaceContextBlock(files: WorkspaceContextFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const sections = files.map((file) => `### ${file.name}\n\n${file.content}`);
  return [
    "## Contexto do workspace",
    "Os arquivos abaixo descrevem o projeto e suas convenções; use-os como contexto.",
    ...sections,
  ].join("\n\n");
}

export function buildRefineSystemInstruction(context?: string): string {
  return context ? `${REFINE_SYSTEM_INSTRUCTION}\n\n${context}` : REFINE_SYSTEM_INSTRUCTION;
}

export function buildChatSystemInstruction(context?: string): string {
  return context ? `${CHAT_SYSTEM_INSTRUCTION}\n\n${context}` : CHAT_SYSTEM_INSTRUCTION;
}

/** Composes the user turn when the current prompt is included as chat context. */
export function buildChatUserMessage(message: string, promptContent?: string): string {
  if (!promptContent) {
    return message;
  }
  return `${message}\n\n---\n**Conteúdo do prompt atual:**\n${promptContent}`;
}

export interface NamedContent {
  name: string;
  content: string;
}

/** Thoth's "selected context files" block, verbatim format. */
export function buildSelectedFilesBlock(files: NamedContent[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const sections = files.map((file) => `### ${file.name}\n\n${file.content}`);
  return ["## Arquivos de contexto selecionados", ...sections].join("\n\n");
}

/** Thoth's custom instructions block, verbatim format. */
export function buildCustomInstructionsBlock(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return `## Instruções adicionais do usuário\n\nAo refinar, siga estas instruções:\n${trimmed}`;
}

/** Files referenced via @mentions (in the prompt or in a chat message). */
export function buildMentionedFilesBlock(files: NamedContent[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }
  const sections = files.map((file) => `### ${file.name}\n\n${file.content}`);
  return [
    "## Arquivos mencionados",
    "Os arquivos abaixo foram referenciados com @menções; use-os como contexto.",
    ...sections,
  ].join("\n\n");
}

export const MAX_DIRECTORY_ENTRIES = 200;

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/** Shallow listing attached for `@dir/` mentions: subdirs first, capped. */
export function buildDirectoryListing(entries: DirectoryEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
  );
  const shown = sorted.slice(0, MAX_DIRECTORY_ENTRIES);
  const lines = shown.map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name));
  const omitted = sorted.length - shown.length;
  if (omitted > 0) {
    lines.push(`… (+${omitted} entradas omitidas)`);
  }
  return ["(listagem de diretório — 1º nível)", ...lines].join("\n");
}

export function buildLinkedPlanBlock(displayName: string, content: string): string | undefined {
  if (!content.trim()) {
    return undefined;
  }
  return `## Plano vinculado (${displayName})\n\n${content}`;
}

export function buildParentPromptBlock(content: string): string | undefined {
  if (!content.trim()) {
    return undefined;
  }
  return `## Prompt pai\n\nEste prompt é um prompt filho; o prompt pai da tarefa é:\n\n${content}`;
}

export interface WorkflowStateContext {
  phaseName?: string;
  actorLabel?: string;
  status: string;
  iteration: number;
  recentNotes: string[];
}

export function buildWorkflowStateBlock(state: WorkflowStateContext): string {
  const lines = [
    "## Estado da tarefa",
    "",
    `- Status do fluxo: ${state.status === "Done" ? "Concluída" : "Em andamento"}`,
  ];
  if (state.phaseName) {
    lines.push(`- Fase atual: ${state.phaseName}`);
  }
  if (state.actorLabel) {
    lines.push(`- Responsável atual: ${state.actorLabel}`);
  }
  if (state.iteration > 1) {
    lines.push(`- Iteração da fase: ${state.iteration}`);
  }
  if (state.recentNotes.length > 0) {
    lines.push("- Últimas notas da timeline:");
    for (const note of state.recentNotes) {
      lines.push(`  - ${note}`);
    }
  }
  return lines.join("\n");
}

export function buildGitContextBlock(branch: string, commits: string[]): string | undefined {
  if (!branch && commits.length === 0) {
    return undefined;
  }
  const lines = ["## Contexto git", ""];
  if (branch) {
    lines.push(`Branch atual: ${branch}`);
  }
  if (commits.length > 0) {
    lines.push("", "Últimos commits:", "```", ...commits, "```");
  }
  return lines.join("\n");
}
