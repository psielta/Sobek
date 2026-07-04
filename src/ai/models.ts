/** Curated Gemini model catalog, mirroring Thoth's `Gemini.Models` configuration. */

export type ThinkingMode = "none" | "budget" | "level";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiModelInfo {
  id: string;
  label: string;
  thinkingMode: ThinkingMode;
  canDisableThinking: boolean;
  budgetMin: number;
  budgetMax: number;
}

export const GEMINI_MODELS: GeminiModelInfo[] = [
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    thinkingMode: "level",
    canDisableThinking: false,
    budgetMin: 0,
    budgetMax: 0,
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro (Preview)",
    thinkingMode: "level",
    canDisableThinking: false,
    budgetMin: 0,
    budgetMax: 0,
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    thinkingMode: "level",
    canDisableThinking: false,
    budgetMin: 0,
    budgetMax: 0,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    thinkingMode: "budget",
    canDisableThinking: true,
    budgetMin: 1,
    budgetMax: 24576,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    thinkingMode: "budget",
    canDisableThinking: false,
    budgetMin: 128,
    budgetMax: 32768,
  },
];

export const DEFAULT_MODEL = "gemini-3.5-flash";

export interface AiSettings {
  model: string;
  temperature: number;
  thinkingEnabled: boolean;
  thinkingBudget: number | null;
  thinkingLevel: ThinkingLevel | null;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  model: DEFAULT_MODEL,
  temperature: 0.7,
  thinkingEnabled: true,
  thinkingBudget: null,
  thinkingLevel: "high",
};

export function findModel(id: string): GeminiModelInfo | undefined {
  return GEMINI_MODELS.find((model) => model.id === id);
}

/** Same derivation Thoth's frontend applies before each AI request. */
export function deriveThinkingMode(settings: AiSettings): ThinkingMode {
  if (!settings.thinkingEnabled) {
    return "none";
  }
  if (settings.thinkingBudget !== null && settings.thinkingBudget !== undefined) {
    return "budget";
  }
  if (settings.thinkingLevel !== null && settings.thinkingLevel !== undefined) {
    return "level";
  }
  return "none";
}
