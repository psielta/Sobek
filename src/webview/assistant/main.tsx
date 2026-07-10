import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeTranslator, resolveLocale, type Dictionary } from "../i18n";
import "@vscode/codicons/dist/codicon.css";
import "./assistant.css";

interface ChatTurn {
  role: "user" | "model";
  text: string;
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
  | "copied";

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
};

const t = makeTranslator(DICT, resolveLocale(host.__SOBEK_STATE__?.language));

interface LiveMessage {
  answer: string;
  thoughts: string;
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
          setLive({ answer: "", thoughts: "" });
          setBusy(true);
          setError(undefined);
          break;
        case "chunk":
          setLive((current) => {
            const base = current ?? { answer: "", thoughts: "" };
            return message.isThought
              ? { ...base, thoughts: base.thoughts + (message.text ?? "") }
              : { ...base, answer: base.answer + (message.text ?? "") };
          });
          break;
        case "done":
          setLive((current) => {
            if (current && current.answer) {
              setHistory((turns) => [...turns, { role: "model", text: current.answer }]);
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
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const next = `${input.slice(0, mention.start)}${file} ${input.slice(cursor)}`;
    setInput(next);
    setMention(undefined);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const position = mention.start + file.length + 1;
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

      <div className="chat-messages">
        {history.length === 0 && !live && <p className="chat-empty">{t("emptyChat")}</p>}
        {history.map((turn, index) => (
          <div key={index} className={`msg msg-${turn.role}`}>
            {turn.role === "model" ? (
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {turn.text}
                </Markdown>
              </div>
            ) : (
              <pre>{turn.text}</pre>
            )}
          </div>
        ))}
        {live && (
          <div className="msg msg-model">
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
              <pre>…</pre>
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
                const slash = file.lastIndexOf("/");
                const name = slash >= 0 ? file.slice(slash + 1) : file;
                const dir = slash >= 0 ? file.slice(0, slash) : "";
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
                    <i className="codicon codicon-file" />
                    <span className="mention-name">{name}</span>
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
