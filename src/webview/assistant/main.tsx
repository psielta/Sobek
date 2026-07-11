import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeTranslator, resolveLocale, type Dictionary } from "../i18n";
import "@vscode/codicons/dist/codicon.css";
import "./assistant.css";

interface ToolChip {
  name: string;
  ok: boolean;
}

interface LiveToolCall {
  callId: number;
  name: string;
  status: "running" | "ok" | "error";
  detail?: string;
}

interface ChatTurn {
  role: "user" | "model";
  text: string;
  tools?: ToolChip[];
}

interface ModelInfo {
  id: string;
  label: string;
}

interface AiSettings {
  model: string;
  temperature: number;
  thinkingLevel: string | null;
}

interface ActivePrompt {
  id: string;
  title: string;
  isChild: boolean;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const host = window as unknown as {
  __SOBEK_STATE__: {
    history: ChatTurn[];
    models: ModelInfo[];
    settings: AiSettings;
    activePrompt: ActivePrompt | null;
    language?: string;
  } | null;
  acquireVsCodeApi(): VsCodeApi;
};
const vscode = host.acquireVsCodeApi();

type AssistantKey =
  | "modelInUse"
  | "aiSettings"
  | "geminiKey"
  | "clearChat"
  | "emptyChat"
  | "reasoning"
  | "useAsContext"
  | "noPromptOpen"
  | "childPromptOpen"
  | "promptOpen"
  | "placeholder"
  | "stopGeneration"
  | "sendTitle"
  | "copyCode"
  | "copied"
  | "helpTitle"
  | "helpHeading"
  | "helpIntro"
  | "helpLimits"
  | "helpClickHint"
  | "closeHelp";

const DICT: Dictionary<AssistantKey> = {
  modelInUse: { en: "Model in use", "pt-br": "Modelo em uso" },
  aiSettings: { en: "AI settings", "pt-br": "Configurações de IA" },
  geminiKey: { en: "Gemini key", "pt-br": "Chave Gemini" },
  clearChat: { en: "Clear conversation", "pt-br": "Limpar conversa" },
  emptyChat: {
    en: "Prompt engineering assistant (Gemini). Ask how to structure, review or split your prompts. Use the box below to attach the open prompt as context.",
    "pt-br":
      "Assistente de engenharia de prompts (Gemini). Pergunte sobre como estruturar, revisar ou dividir seus prompts. Use a caixa abaixo para incluir o prompt aberto como contexto.",
  },
  reasoning: { en: "Reasoning", "pt-br": "Raciocínio" },
  useAsContext: { en: "Use as context:", "pt-br": "Usar como contexto:" },
  noPromptOpen: {
    en: "no prompt open in the editor",
    "pt-br": "nenhum prompt aberto no editor",
  },
  childPromptOpen: {
    en: "Child prompt open in the editor",
    "pt-br": "Prompt filho aberto no editor",
  },
  promptOpen: { en: "Prompt open in the editor", "pt-br": "Prompt aberto no editor" },
  placeholder: {
    en: "Ask the assistant... (@ mentions files, Shift+Enter for a new line)",
    "pt-br": "Pergunte ao assistente... (@ menciona arquivos, Shift+Enter quebra linha)",
  },
  stopGeneration: { en: "Stop generation", "pt-br": "Parar geração" },
  sendTitle: { en: "Send (Enter)", "pt-br": "Enviar (Enter)" },
  copyCode: { en: "Copy code", "pt-br": "Copiar código" },
  copied: { en: "Copied", "pt-br": "Copiado" },
  helpTitle: { en: "Help and examples", "pt-br": "Ajuda e exemplos" },
  helpHeading: { en: "What can I ask for?", "pt-br": "O que posso pedir?" },
  helpIntro: {
    en: "The assistant can act on your prompts: it reads, edits, creates and manages workflows via tools. Some examples:",
    "pt-br":
      "O assistente age sobre seus prompts: lê, edita, cria e gerencia workflows por ferramentas. Alguns exemplos:",
  },
  helpLimits: {
    en: "It never archives, deletes or opens terminals — those stay with you. Every content write creates a version (reversible). Tools can be disabled via the sobek.ai.enableTools setting.",
    "pt-br":
      "Ele nunca arquiva, exclui ou abre terminais — isso fica com você. Toda escrita de conteúdo cria versão (reversível). As ferramentas podem ser desligadas na configuração sobek.ai.enableTools.",
  },
  helpClickHint: {
    en: "Click an example to place it in the message box.",
    "pt-br": "Clique num exemplo para colocá-lo na caixa de mensagem.",
  },
  closeHelp: { en: "Close help", "pt-br": "Fechar ajuda" },
};

interface HelpSection {
  heading: { en: string; "pt-br": string };
  examples: Array<{ en: string; "pt-br": string }>;
}

const HELP_SECTIONS: HelpSection[] = [
  {
    heading: { en: "Refine and edit", "pt-br": "Refinar e editar" },
    examples: [
      { en: "Refine this prompt and apply it", "pt-br": "Refine este prompt e aplique" },
      {
        en: "Make this prompt shorter, as a checklist, and apply it",
        "pt-br": "Deixe este prompt mais curto, em formato de checklist, e aplique",
      },
      {
        en: "Add an acceptance criteria section to this prompt",
        "pt-br": "Adicione uma seção de critérios de aceite neste prompt",
      },
      {
        en: "Rename this prompt to 'CSV export v2'",
        "pt-br": "Renomeie este prompt para 'Exportação CSV v2'",
      },
    ],
  },
  {
    heading: { en: "Explore the workspace", "pt-br": "Consultar o workspace" },
    examples: [
      {
        en: "List my prompts, including children",
        "pt-br": "Liste meus prompts, incluindo os filhos",
      },
      {
        en: "Which workflow phase is this prompt in?",
        "pt-br": "Em que fase está o workflow deste prompt?",
      },
      {
        en: "Which child prompt templates exist and what does each one require?",
        "pt-br": "Quais templates de prompt filho existem e o que cada um exige?",
      },
    ],
  },
  {
    heading: { en: "Create prompts", "pt-br": "Criar prompts" },
    examples: [
      {
        en: "Create a prompt to implement JWT authentication, Codex agent",
        "pt-br": "Crie um prompt para implementar autenticação JWT, agente Codex",
      },
      {
        en: "Create a plan-review child prompt for this prompt",
        "pt-br": "Crie um prompt filho de revisão de plano para este prompt",
      },
      {
        en: "Create the review child for PR #42",
        "pt-br": "Crie o filho de revisão do PR #42",
      },
    ],
  },
  {
    heading: { en: "Manage the workflow", "pt-br": "Gerenciar o workflow" },
    examples: [
      {
        en: "Add a workflow note: 'plan approved by the team'",
        "pt-br": "Adicione uma nota no workflow: 'plano aprovado pelo time'",
      },
      { en: "Advance this prompt's workflow", "pt-br": "Avance o workflow deste prompt" },
      { en: "Mark this prompt as Ready", "pt-br": "Marque este prompt como Ready" },
    ],
  },
  {
    heading: { en: "Combine actions", "pt-br": "Combinar ações" },
    examples: [
      {
        en: "Refine this prompt, mark it Ready and log a workflow note about the review",
        "pt-br": "Refine este prompt, marque como Ready e registre uma nota da revisão no workflow",
      },
      {
        en: "Review my Draft prompts and tell me which are ready to become Ready",
        "pt-br": "Revise meus prompts em Draft e diga quais estão prontos para virar Ready",
      },
    ],
  },
  {
    heading: { en: "Attach context", "pt-br": "Anexar contexto" },
    examples: [
      {
        en: "Use @file.ts or @folder/ in the message to attach workspace context",
        "pt-br": "Use @arquivo.ts ou @pasta/ na mensagem para anexar contexto do workspace",
      },
      {
        en: "Tick 'Use as context' to include the prompt open in the editor",
        "pt-br": "Marque 'Usar como contexto' para incluir o prompt aberto no editor",
      },
    ],
  },
];

const locale = resolveLocale(host.__SOBEK_STATE__?.language);
const t = makeTranslator(DICT, locale);

/** Chip labels per tool; unknown names fall back to the raw tool name. */
const TOOL_LABELS: Dictionary<string> = {
  get_active_prompt: { en: "Reading prompt", "pt-br": "Lendo prompt" },
  get_prompt: { en: "Reading prompt", "pt-br": "Lendo prompt" },
  list_prompts: { en: "Listing prompts", "pt-br": "Listando prompts" },
  get_workflow_state: { en: "Reading workflow", "pt-br": "Lendo workflow" },
  list_templates: { en: "Listing templates", "pt-br": "Listando templates" },
  update_prompt_content: { en: "Updating prompt", "pt-br": "Atualizando prompt" },
  update_prompt_title: { en: "Renaming prompt", "pt-br": "Renomeando prompt" },
  create_prompt: { en: "Creating prompt", "pt-br": "Criando prompt" },
  create_child_prompt: { en: "Creating child prompt", "pt-br": "Criando prompt filho" },
  add_workflow_note: { en: "Adding note", "pt-br": "Adicionando nota" },
  advance_workflow: { en: "Advancing workflow", "pt-br": "Avançando workflow" },
  set_prompt_status: { en: "Changing status", "pt-br": "Mudando status" },
};
const toolLabel = makeTranslator(TOOL_LABELS, locale);

/** Localized examples of what the assistant can do; clicking one fills the composer. */
function HelpPanel({ onPick, onClose }: { onPick: (example: string) => void; onClose: () => void }) {
  return (
    <div className="help-panel">
      <div className="help-header">
        <h2>{t("helpHeading")}</h2>
        <button onClick={onClose} title={t("closeHelp")}>
          <i className="codicon codicon-close" />
        </button>
      </div>
      <p className="help-intro">{t("helpIntro")}</p>
      <p className="help-hint">{t("helpClickHint")}</p>
      {HELP_SECTIONS.map((section) => (
        <section key={section.heading.en}>
          <h3>{section.heading[locale]}</h3>
          <ul>
            {section.examples.map((example) => (
              <li key={example.en}>
                <button className="help-example" onClick={() => onPick(example[locale])}>
                  {example[locale]}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="help-limits">{t("helpLimits")}</p>
    </div>
  );
}

function ToolChips({ tools }: { tools: LiveToolCall[] }) {
  if (tools.length === 0) {
    return null;
  }
  return (
    <div className="tool-chips">
      {tools.map((tool) => (
        <span
          key={tool.callId}
          className={`tool-chip${tool.status === "error" ? " tool-chip-error" : ""}`}
          title={tool.detail}
        >
          <i
            className={`codicon ${
              tool.status === "running"
                ? "codicon-loading codicon-modifier-spin"
                : tool.status === "ok"
                  ? "codicon-check"
                  : "codicon-error"
            }`}
          />
          {toolLabel(tool.name)}
        </span>
      ))}
    </div>
  );
}

interface LiveMessage {
  answer: string;
  thoughts: string;
  tools: LiveToolCall[];
}

interface MentionState {
  /** Offset of the char right after the "@" in the textarea value. */
  start: number;
  query: string;
  items: string[];
  active: number;
}

/** Finds an "@query" token ending at the cursor, like the editor provider. */
function findMentionToken(value: string, cursor: number): { start: number; query: string } | undefined {
  const prefix = value.slice(0, cursor);
  const match = /(^|[\s([{])@([\w./\\()-]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const query = match[2] ?? "";
  return { start: cursor - query.length, query };
}

/** Fenced code block with a copy-to-clipboard button (rendered for markdown `pre`). */
function CodeBlock({ children, ...rest }: React.ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = preRef.current?.innerText ?? "";
    void navigator.clipboard.writeText(text.replace(/\n$/, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <button
        className={`code-copy${copied ? " code-copy-done" : ""}`}
        title={copied ? t("copied") : t("copyCode")}
        onClick={copy}
      >
        <i className={`codicon codicon-${copied ? "check" : "copy"}`} />
      </button>
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
    </div>
  );
}

const markdownComponents = { pre: CodeBlock };

function App() {
  const initial = host.__SOBEK_STATE__;
  const [history, setHistory] = useState<ChatTurn[]>(initial?.history ?? []);
  const [settings, setSettings] = useState<AiSettings | undefined>(initial?.settings);
  const [input, setInput] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(
    initial?.activePrompt ?? null
  );
  const [live, setLive] = useState<LiveMessage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [mention, setMention] = useState<MentionState | undefined>();
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchSeq = useRef(0);
  const searchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        text?: string;
        isThought?: boolean;
        message?: string;
        history?: ChatTurn[];
        settings?: AiSettings;
        files?: string[];
        requestId?: number;
        prompt?: ActivePrompt | null;
        activePrompt?: ActivePrompt | null;
        callId?: number;
        name?: string;
        status?: "running" | "ok" | "error";
        detail?: string;
      };
      switch (message.type) {
        case "activePrompt":
          setActivePrompt(message.prompt ?? null);
          break;
        case "fileResults":
          if (message.requestId === searchSeq.current) {
            setMention((current) =>
              current
                ? { ...current, items: message.files ?? [], active: 0 }
                : current
            );
          }
          break;
        case "init":
          setHistory(message.history ?? []);
          setSettings(message.settings);
          setActivePrompt(message.activePrompt ?? null);
          break;
        case "userMessage":
          setHistory((current) => [...current, { role: "user", text: message.text ?? "" }]);
          setLive({ answer: "", thoughts: "", tools: [] });
          setBusy(true);
          setError(undefined);
          break;
        case "chunk":
          setLive((current) => {
            const base = current ?? { answer: "", thoughts: "", tools: [] };
            return message.isThought
              ? { ...base, thoughts: base.thoughts + (message.text ?? "") }
              : { ...base, answer: base.answer + (message.text ?? "") };
          });
          break;
        case "toolCall":
          setLive((current) => {
            const base = current ?? { answer: "", thoughts: "", tools: [] };
            const update: LiveToolCall = {
              callId: message.callId ?? 0,
              name: message.name ?? "",
              status: message.status ?? "running",
              detail: message.detail,
            };
            const tools = base.tools.some((tool) => tool.callId === update.callId)
              ? base.tools.map((tool) => (tool.callId === update.callId ? update : tool))
              : [...base.tools, update];
            return { ...base, tools };
          });
          break;
        case "done":
          setLive((current) => {
            if (current && (current.answer || current.tools.length > 0)) {
              setHistory((turns) => [
                ...turns,
                {
                  role: "model",
                  text: current.answer,
                  tools:
                    current.tools.length > 0
                      ? current.tools.map((tool) => ({ name: tool.name, ok: tool.status === "ok" }))
                      : undefined,
                },
              ]);
            }
            return undefined;
          });
          setBusy(false);
          break;
        case "error":
          setError(message.message);
          setLive(undefined);
          setBusy(false);
          break;
        case "cleared":
          setHistory([]);
          setLive(undefined);
          setBusy(false);
          setError(undefined);
          break;
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, live]);

  const send = () => {
    if (!input.trim() || busy) {
      return;
    }
    vscode.postMessage({ type: "send", text: input, includePromptContext: includeContext });
    setInput("");
    setMention(undefined);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
    }
  };

  /** Grows the composer with the content, capped at ~6 lines. */
  const autoGrow = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  };

  const updateMention = (value: string, cursor: number) => {
    const token = findMentionToken(value, cursor);
    if (!token) {
      setMention(undefined);
      return;
    }
    setMention((current) => ({
      start: token.start,
      query: token.query,
      items: current?.start === token.start ? current.items : [],
      active: current?.start === token.start ? current.active : 0,
    }));
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchSeq.current += 1;
      vscode.postMessage({
        type: "searchFiles",
        query: token.query,
        requestId: searchSeq.current,
      });
    }, 120);
  };

  const applyMention = (file: string) => {
    if (!mention) {
      return;
    }
    // Directories (trailing "/") drill down: no closing space, dropdown stays
    // open searching inside the folder — like Claude Code's @ picker.
    const isDirectory = file.endsWith("/");
    const suffix = isDirectory ? "" : " ";
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const next = `${input.slice(0, mention.start)}${file}${suffix}${input.slice(cursor)}`;
    setInput(next);
    if (isDirectory) {
      setMention({ start: mention.start, query: file, items: [], active: 0 });
      searchSeq.current += 1;
      vscode.postMessage({ type: "searchFiles", query: file, requestId: searchSeq.current });
    } else {
      setMention(undefined);
    }
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const position = mention.start + file.length + suffix.length;
        textarea.focus();
        textarea.setSelectionRange(position, position);
      }
    });
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ ...mention, active: (mention.active + 1) % mention.items.length });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + mention.items.length) % mention.items.length,
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(mention.items[mention.active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(undefined);
        return;
      }
    }
    // Enter submits; Shift+Enter inserts a newline (standard AI chat UX).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="chat-model" title={t("modelInUse")}>
          <i className="codicon codicon-sparkle" /> {settings?.model ?? "gemini"}
        </span>
        <button
          onClick={() => setShowHelp((current) => !current)}
          title={t("helpTitle")}
          className={showHelp ? "active" : undefined}
        >
          <i className="codicon codicon-question" />
        </button>
        <button onClick={() => vscode.postMessage({ type: "configure" })} title={t("aiSettings")}>
          <i className="codicon codicon-settings-gear" />
        </button>
        <button onClick={() => vscode.postMessage({ type: "setApiKey" })} title={t("geminiKey")}>
          <i className="codicon codicon-key" />
        </button>
        <button onClick={() => vscode.postMessage({ type: "clear" })} title={t("clearChat")}>
          <i className="codicon codicon-clear-all" />
        </button>
      </header>

      {showHelp && (
        <HelpPanel
          onClose={() => setShowHelp(false)}
          onPick={(example) => {
            setInput(example);
            setShowHelp(false);
            requestAnimationFrame(() => {
              textareaRef.current?.focus();
              autoGrow();
            });
          }}
        />
      )}

      <div className="chat-messages" style={showHelp ? { display: "none" } : undefined}>
        {history.length === 0 && !live && <p className="chat-empty">{t("emptyChat")}</p>}
        {history.map((turn, index) => (
          <div key={index} className={`msg msg-${turn.role}`}>
            {turn.role === "model" ? (
              <>
                {turn.tools && (
                  <ToolChips
                    tools={turn.tools.map((tool, callId) => ({
                      callId,
                      name: tool.name,
                      status: tool.ok ? "ok" : "error",
                    }))}
                  />
                )}
                <div className="markdown">
                  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {turn.text}
                  </Markdown>
                </div>
              </>
            ) : (
              <pre>{turn.text}</pre>
            )}
          </div>
        ))}
        {live && (
          <div className="msg msg-model">
            <ToolChips tools={live.tools} />
            {live.thoughts && !live.answer && (
              <details open>
                <summary>{t("reasoning")}</summary>
                <pre className="thoughts">{live.thoughts}</pre>
              </details>
            )}
            {live.answer ? (
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {live.answer}
                </Markdown>
              </div>
            ) : (
              !live.tools.length && <pre>…</pre>
            )}
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
        <div ref={endRef} />
      </div>

      <footer className="chat-input">
        <label className={`chat-context${!activePrompt ? " chat-context-disabled" : ""}`}>
          <input
            type="checkbox"
            checked={includeContext && !!activePrompt}
            disabled={!activePrompt}
            onChange={(event) => setIncludeContext(event.target.checked)}
          />
          {t("useAsContext")}
          {activePrompt ? (
            <span
              className={`context-chip${includeContext ? " context-chip-on" : ""}`}
              title={activePrompt.isChild ? t("childPromptOpen") : t("promptOpen")}
            >
              <i
                className={`codicon ${activePrompt.isChild ? "codicon-git-branch" : "codicon-note"}`}
              />
              {activePrompt.title}
            </span>
          ) : (
            <span className="context-chip context-chip-empty">{t("noPromptOpen")}</span>
          )}
        </label>
        <div className="chat-input-row">
          {mention && mention.items.length > 0 && (
            <ul className="mention-dropdown">
              {mention.items.map((file, index) => {
                const isDirectory = file.endsWith("/");
                const base = isDirectory ? file.slice(0, -1) : file;
                const slash = base.lastIndexOf("/");
                const name = slash >= 0 ? base.slice(slash + 1) : base;
                const dir = slash >= 0 ? base.slice(0, slash) : "";
                return (
                  <li
                    key={file}
                    title={file}
                    className={index === mention.active ? "active" : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyMention(file);
                    }}
                  >
                    <i className={`codicon ${isDirectory ? "codicon-folder" : "codicon-file"}`} />
                    <span className="mention-name">{isDirectory ? `${name}/` : name}</span>
                    {dir && <span className="mention-dir">{dir}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              placeholder={t("placeholder")}
              onChange={(event) => {
                setInput(event.target.value);
                updateMention(event.target.value, event.target.selectionStart ?? 0);
                autoGrow();
              }}
              onKeyDown={onInputKeyDown}
              onBlur={() => window.setTimeout(() => setMention(undefined), 150)}
            />
            {busy ? (
              <button
                className="composer-action stop"
                title={t("stopGeneration")}
                onClick={() => vscode.postMessage({ type: "stop" })}
              >
                <i className="codicon codicon-debug-stop" />
              </button>
            ) : (
              <button
                className="composer-action"
                title={t("sendTitle")}
                onClick={send}
                disabled={!input.trim()}
              >
                <i className="codicon codicon-send" />
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
