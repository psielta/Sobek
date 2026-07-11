/**
 * Function-calling tool declarations for the chat assistant. Pure module:
 * only JSON schemas and arg helpers — execution lives in `src/ai/tools.ts`.
 * Descriptions are pt-BR, matching the assistant's system instruction locale.
 */

import type { GeminiFunctionDeclaration } from "./gemini-client";

/** Prompt content payloads are clamped so tool responses stay bounded. */
export const MAX_TOOL_CONTENT_CHARS = 24_000;

/** Hard cap on request→tool→request iterations within one chat message. */
export const MAX_TOOL_LOOP_ITERATIONS = 6;

const PROMPT_ID_PARAM = {
  type: "STRING",
  description: "Id do prompt alvo. Omita para usar o prompt aberto no editor.",
};

export const ASSISTANT_TOOLS: GeminiFunctionDeclaration[] = [
  {
    name: "get_active_prompt",
    description:
      "Lê o prompt aberto no editor: metadados e conteúdo completo. Use antes de propor ou aplicar mudanças.",
  },
  {
    name: "list_prompts",
    description: "Lista os prompts do workspace (sem conteúdo): id, título, status e tipo.",
    parameters: {
      type: "OBJECT",
      properties: {
        include_children: {
          type: "BOOLEAN",
          description: "Inclui os prompts filhos de cada prompt raiz.",
        },
      },
    },
  },
  {
    name: "get_prompt",
    description: "Lê um prompt específico pelo id: metadados e conteúdo completo.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: { type: "STRING", description: "Id do prompt (veja list_prompts)." },
      },
      required: ["prompt_id"],
    },
  },
  {
    name: "get_workflow_state",
    description:
      "Lê o estado do workflow de um prompt: fase atual, responsável, iteração, fases e notas recentes.",
    parameters: {
      type: "OBJECT",
      properties: { prompt_id: PROMPT_ID_PARAM },
    },
  },
  {
    name: "list_templates",
    description:
      "Lista os templates de prompt filho disponíveis, com os inputs exigidos por cada um. Use antes de create_child_prompt.",
  },
  {
    name: "update_prompt_content",
    description:
      "Substitui o conteúdo Markdown de um prompt pelo texto dado (completo, não parcial). Cria versão nova automaticamente; use ao refinar/reescrever.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: PROMPT_ID_PARAM,
        content: {
          type: "STRING",
          description: "Novo conteúdo Markdown completo do prompt.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "update_prompt_title",
    description: "Renomeia um prompt.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: PROMPT_ID_PARAM,
        title: { type: "STRING", description: "Novo título (não vazio)." },
      },
      required: ["title"],
    },
  },
  {
    name: "create_prompt",
    description: "Cria um prompt raiz novo no workspace.",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "Título do prompt." },
        content: { type: "STRING", description: "Conteúdo Markdown inicial." },
        kind: {
          type: "STRING",
          enum: ["General", "Planning"],
          description: "Tipo do prompt (padrão General).",
        },
        target_agent: {
          type: "STRING",
          enum: ["ClaudeCode", "Codex", "Grok"],
          description: "Agente alvo (padrão ClaudeCode).",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "create_child_prompt",
    description:
      "Cria um prompt filho a partir de um template (list_templates). Exige plano vinculado no pai; avança a fase do workflow do pai quando o template define uma fase alvo.",
    parameters: {
      type: "OBJECT",
      properties: {
        parent_prompt_id: {
          type: "STRING",
          description: "Id do prompt pai (raiz). Omita para usar o prompt aberto.",
        },
        template_key: {
          type: "STRING",
          description: "Chave do template (ex.: ReviewPlan, ImplementPlan, custom:slug).",
        },
        title: { type: "STRING", description: "Título do filho (padrão: nome do template)." },
        inputs: {
          type: "OBJECT",
          description: "Valores para os inputs declarados pelo template (chave → texto).",
        },
        pull_request: {
          type: "STRING",
          description: "Referência de PR (#123 ou URL), exigida por alguns templates.",
        },
      },
      required: ["template_key"],
    },
  },
  {
    name: "add_workflow_note",
    description: "Adiciona uma nota à timeline do workflow de um prompt.",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: PROMPT_ID_PARAM,
        note: { type: "STRING", description: "Texto da nota (não vazio)." },
      },
      required: ["note"],
    },
  },
  {
    name: "advance_workflow",
    description:
      "Avança o workflow de um prompt para a próxima fase (conclui se estiver na última).",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: PROMPT_ID_PARAM,
        note: { type: "STRING", description: "Nota opcional registrada na mudança de fase." },
      },
    },
  },
  {
    name: "set_prompt_status",
    description: "Define o status de um prompt como Draft ou Ready (arquivar não é permitido).",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt_id: PROMPT_ID_PARAM,
        status: { type: "STRING", enum: ["Draft", "Ready"], description: "Novo status." },
      },
      required: ["status"],
    },
  },
];

export const ASSISTANT_TOOL_NAMES = ASSISTANT_TOOLS.map((tool) => tool.name);

export function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Argumento obrigatório ausente ou vazio: ${key}`);
  }
  return value;
}

export function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function clampContent(text: string): { content: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_CONTENT_CHARS) {
    return { content: text, truncated: false };
  }
  return { content: text.slice(0, MAX_TOOL_CONTENT_CHARS), truncated: true };
}
