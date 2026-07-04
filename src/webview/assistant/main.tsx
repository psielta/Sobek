import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  } | null;
  acquireVsCodeApi(): VsCodeApi;
};
const vscode = host.acquireVsCodeApi();

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
  const match = /(^|[\s([{])@([\w./\\-]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }
  const query = match[2] ?? "";
  return { start: cursor - query.length, query };
}

function App() {
  const initial = host.__SOBEK_STATE__;
  const [history, setHistory] = useState<ChatTurn[]>(initial?.history ?? []);
  const [settings, setSettings] = useState<AiSettings | undefined>(initial?.settings);
  const [input, setInput] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
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
      };
      switch (message.type) {
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
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="chat">
      <header className="chat-header">
        <span className="chat-model" title="Modelo em uso">
          {settings?.model ?? "gemini"}
        </span>
        <button onClick={() => vscode.postMessage({ type: "configure" })} title="Configurações de IA">
          ⚙
        </button>
        <button onClick={() => vscode.postMessage({ type: "setApiKey" })} title="Chave Gemini">
          🔑
        </button>
        <button onClick={() => vscode.postMessage({ type: "clear" })} title="Limpar conversa">
          ✕
        </button>
      </header>

      <div className="chat-messages">
        {history.length === 0 && !live && (
          <p className="chat-empty">
            Assistente de engenharia de prompts (Gemini). Pergunte sobre como estruturar,
            revisar ou dividir seus prompts. Use a caixa abaixo para incluir o prompt aberto
            como contexto.
          </p>
        )}
        {history.map((turn, index) => (
          <div key={index} className={`msg msg-${turn.role}`}>
            {turn.role === "model" ? (
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>
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
                <summary>Raciocínio</summary>
                <pre className="thoughts">{live.thoughts}</pre>
              </details>
            )}
            {live.answer ? (
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{live.answer}</Markdown>
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
        <label className="chat-context">
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(event) => setIncludeContext(event.target.checked)}
          />
          Incluir prompt atual como contexto
        </label>
        <div className="chat-input-row">
          {mention && mention.items.length > 0 && (
            <ul className="mention-dropdown">
              {mention.items.map((file, index) => (
                <li
                  key={file}
                  className={index === mention.active ? "active" : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(file);
                  }}
                >
                  {file}
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            rows={3}
            placeholder="Pergunte ao assistente... @ menciona arquivos (Ctrl+Enter envia)"
            onChange={(event) => {
              setInput(event.target.value);
              updateMention(event.target.value, event.target.selectionStart ?? 0);
            }}
            onKeyDown={onInputKeyDown}
            onBlur={() => window.setTimeout(() => setMention(undefined), 150)}
          />
          {busy ? (
            <button onClick={() => vscode.postMessage({ type: "stop" })}>Parar</button>
          ) : (
            <button onClick={send} disabled={!input.trim()}>
              Enviar
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
