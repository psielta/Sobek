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

function App() {
  const initial = host.__SOBEK_STATE__;
  const [history, setHistory] = useState<ChatTurn[]>(initial?.history ?? []);
  const [settings, setSettings] = useState<AiSettings | undefined>(initial?.settings);
  const [input, setInput] = useState("");
  const [includeContext, setIncludeContext] = useState(false);
  const [live, setLive] = useState<LiveMessage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as {
        type: string;
        text?: string;
        isThought?: boolean;
        message?: string;
        history?: ChatTurn[];
        settings?: AiSettings;
      };
      switch (message.type) {
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
          <textarea
            value={input}
            rows={3}
            placeholder="Pergunte ao assistente... (Ctrl+Enter envia)"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                send();
              }
            }}
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
