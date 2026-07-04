import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./board.css";

interface BoardCard {
  id: string;
  title: string;
  status: string;
  workflowStatus?: string;
  phaseName?: string;
  phaseColor?: string;
  actorLabel?: string;
  iteration: number;
  reviewVerdictSource?: string;
  hasChildren: boolean;
  hasLinkedPlan: boolean;
  updatedAt: string;
}

interface BoardColumn {
  id: string;
  title: string;
  color?: string;
  droppable: boolean;
  cards: BoardCard[];
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): { viewMode?: ViewMode } | undefined;
  setState(state: { viewMode?: ViewMode }): void;
}

const host = window as unknown as {
  __SOBEK_STATE__: { columns: BoardColumn[] } | null;
  acquireVsCodeApi(): VsCodeApi;
};
const vscode = host.acquireVsCodeApi();

type ViewMode = "kanban" | "vertical";
type StatusFilter = "notArchived" | "Draft" | "Ready" | "Archived";
type WorkflowFilter = "all" | "Active" | "Done";

const STATUS_LABELS: Record<string, string> = {
  Draft: "Rascunho",
  Ready: "Pronto",
  Archived: "Arquivado",
};

function matches(card: BoardCard, query: string, status: StatusFilter, flow: WorkflowFilter): boolean {
  if (status === "notArchived" ? card.status === "Archived" : card.status !== status) {
    return false;
  }
  if (flow !== "all" && card.workflowStatus !== flow) {
    return false;
  }
  if (query && !card.title.toLowerCase().includes(query.toLowerCase())) {
    return false;
  }
  return true;
}

function Card({ card }: { card: BoardCard }) {
  return (
    <div
      className={`card${card.actorLabel === "Você" ? " card-human" : ""}`}
      style={{ borderLeftColor: card.phaseColor ?? "var(--vscode-panel-border)" }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/sobek-card", card.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        className="card-title"
        title="Abrir prompt"
        onClick={() => vscode.postMessage({ type: "openPrompt", promptId: card.id })}
      >
        {card.title}
      </button>
      <div className="card-badges">
        {card.actorLabel && <span className="badge">{card.actorLabel}</span>}
        {card.iteration > 1 && <span className="badge badge-warn">re-review #{card.iteration}</span>}
        {card.reviewVerdictSource && (
          <span className="badge badge-warn" title="Correção originada em revisão">
            ⮌ {card.reviewVerdictSource}
          </span>
        )}
        {card.status !== "Ready" && <span className="badge">{STATUS_LABELS[card.status] ?? card.status}</span>}
        {card.hasLinkedPlan && <span className="badge" title="Plano vinculado">📄</span>}
        {card.hasChildren && <span className="badge" title="Tem prompts filhos">⑂</span>}
      </div>
      <div className="card-actions">
        <button onClick={() => vscode.postMessage({ type: "generateChild", promptId: card.id })}>
          Gerar filho
        </button>
        {card.workflowStatus === "Active" && (
          <button onClick={() => vscode.postMessage({ type: "advance", promptId: card.id })}>
            Avançar
          </button>
        )}
        <button onClick={() => vscode.postMessage({ type: "addNote", promptId: card.id })}>
          Nota
        </button>
        <button
          className="danger"
          onClick={() => vscode.postMessage({ type: "archive", promptId: card.id })}
        >
          Arquivar
        </button>
      </div>
    </div>
  );
}

function Column({
  column,
  cards,
}: {
  column: BoardColumn;
  cards: BoardCard[];
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={`column${column.droppable ? " column-droppable" : ""}${over ? " column-over" : ""}`}
      onDragOver={(event) => {
        if (column.droppable && event.dataTransfer.types.includes("text/sobek-card")) {
          event.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const promptId = event.dataTransfer.getData("text/sobek-card");
        if (promptId && column.droppable) {
          vscode.postMessage({ type: "moveTask", promptId, columnId: column.id });
        }
      }}
    >
      <header className="column-header">
        <span className="column-dot" style={{ background: column.color ?? "transparent" }} />
        <h2>{column.title}</h2>
        <span className="column-count">{cards.length}</span>
      </header>
      <div className="column-cards">
        {cards.map((card) => (
          <Card key={card.id} card={card} />
        ))}
      </div>
    </section>
  );
}

function App() {
  const [columns, setColumns] = useState<BoardColumn[]>(host.__SOBEK_STATE__?.columns ?? []);
  const [viewMode, setViewMode] = useState<ViewMode>(vscode.getState()?.viewMode ?? "kanban");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("notArchived");
  const [flow, setFlow] = useState<WorkflowFilter>("all");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { type: string; columns?: BoardColumn[] };
      if (message.type === "state" && message.columns) {
        setColumns(message.columns);
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    vscode.setState({ viewMode });
  }, [viewMode]);

  const visible = useMemo(
    () =>
      columns
        .map((column) => ({
          column,
          cards: column.cards.filter((card) => matches(card, query, status, flow)),
        }))
        .filter(
          ({ column, cards }) =>
            cards.length > 0 || (column.droppable && flow !== "Done") || column.id === "__done__"
        ),
    [columns, query, status, flow]
  );

  return (
    <div className="app">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Buscar tarefa..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          <option value="notArchived">Não arquivadas</option>
          <option value="Draft">Rascunho</option>
          <option value="Ready">Pronto</option>
          <option value="Archived">Arquivadas</option>
        </select>
        <select value={flow} onChange={(event) => setFlow(event.target.value as WorkflowFilter)}>
          <option value="all">Todos os fluxos</option>
          <option value="Active">Em andamento</option>
          <option value="Done">Concluídas</option>
        </select>
        <button
          className="mode-toggle"
          onClick={() => setViewMode(viewMode === "kanban" ? "vertical" : "kanban")}
          title="Alternar entre kanban e visão vertical"
        >
          {viewMode === "kanban" ? "≡ Vertical" : "▥ Kanban"}
        </button>
      </div>
      <div className={`board board-${viewMode}`}>
        {visible.map(({ column, cards }) => (
          <Column key={column.id} column={column} cards={cards} />
        ))}
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
