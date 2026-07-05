import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { makeTranslator, resolveLocale, type Dictionary } from "../i18n";
import "./board.css";

interface BoardTerminal {
  id: string;
  label: string;
  childTitle?: string;
}

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
  terminals: BoardTerminal[];
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
  __SOBEK_STATE__: { columns: BoardColumn[]; language?: string } | null;
  acquireVsCodeApi(): VsCodeApi;
};
const vscode = host.acquireVsCodeApi();

type ViewMode = "kanban" | "vertical";
type StatusFilter = "notArchived" | "Draft" | "Ready" | "Archived";
type WorkflowFilter = "all" | "Active" | "Done";

type BoardKey =
  | "search"
  | "notArchived"
  | "draft"
  | "ready"
  | "archived"
  | "allFlows"
  | "inProgress"
  | "doneFlows"
  | "modeVertical"
  | "modeKanban"
  | "modeToggleTitle"
  | "openPrompt"
  | "generateChild"
  | "run"
  | "advance"
  | "note"
  | "archive"
  | "reReview"
  | "correctionFrom"
  | "hasPlan"
  | "hasChildren"
  | "dropHere"
  | "revealTerminal"
  | "killTerminal"
  | "childTerminal";

const DICT: Dictionary<BoardKey> = {
  search: { en: "Search task...", "pt-br": "Buscar tarefa..." },
  notArchived: { en: "Not archived", "pt-br": "Não arquivadas" },
  draft: { en: "Draft", "pt-br": "Rascunho" },
  ready: { en: "Ready", "pt-br": "Pronto" },
  archived: { en: "Archived", "pt-br": "Arquivadas" },
  allFlows: { en: "All workflows", "pt-br": "Todos os fluxos" },
  inProgress: { en: "In progress", "pt-br": "Em andamento" },
  doneFlows: { en: "Done", "pt-br": "Concluídas" },
  modeVertical: { en: "≡ Vertical", "pt-br": "≡ Vertical" },
  modeKanban: { en: "▥ Kanban", "pt-br": "▥ Kanban" },
  modeToggleTitle: {
    en: "Toggle between kanban and vertical view",
    "pt-br": "Alternar entre kanban e visão vertical",
  },
  openPrompt: { en: "Open prompt", "pt-br": "Abrir prompt" },
  generateChild: { en: "Generate child", "pt-br": "Gerar filho" },
  run: { en: "▶ Run", "pt-br": "▶ Executar" },
  advance: { en: "Advance", "pt-br": "Avançar" },
  note: { en: "Note", "pt-br": "Nota" },
  archive: { en: "Archive", "pt-br": "Arquivar" },
  reReview: { en: "re-review #{0}", "pt-br": "re-review #{0}" },
  correctionFrom: {
    en: "Correction originated in review",
    "pt-br": "Correção originada em revisão",
  },
  hasPlan: { en: "Linked plan", "pt-br": "Plano vinculado" },
  hasChildren: { en: "Has child prompts", "pt-br": "Tem prompts filhos" },
  dropHere: { en: "Drop a card here", "pt-br": "Solte um cartão aqui" },
  revealTerminal: { en: "Show terminal", "pt-br": "Mostrar terminal" },
  killTerminal: { en: "Kill terminal", "pt-br": "Encerrar terminal" },
  childTerminal: { en: "Child prompt terminal: {0}", "pt-br": "Terminal do prompt filho: {0}" },
};

const t = makeTranslator(DICT, resolveLocale(host.__SOBEK_STATE__?.language));

const STATUS_LABELS: Record<string, string> = {
  Draft: t("draft"),
  Ready: t("ready"),
  Archived: t("archived"),
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
        title={t("openPrompt")}
        onClick={() => vscode.postMessage({ type: "openPrompt", promptId: card.id })}
      >
        {card.title}
      </button>
      <div className="card-badges">
        {card.actorLabel && <span className="badge">{card.actorLabel}</span>}
        {card.iteration > 1 && (
          <span className="badge badge-warn">{t("reReview", card.iteration)}</span>
        )}
        {card.reviewVerdictSource && (
          <span className="badge badge-warn" title={t("correctionFrom")}>
            ⮌ {card.reviewVerdictSource}
          </span>
        )}
        {card.status !== "Ready" && <span className="badge">{STATUS_LABELS[card.status] ?? card.status}</span>}
        {card.hasLinkedPlan && <span className="badge" title={t("hasPlan")}>📄</span>}
        {card.hasChildren && <span className="badge" title={t("hasChildren")}>⑂</span>}
      </div>
      {card.terminals.length > 0 && (
        <div className="card-terminals">
          {card.terminals.map((term) => (
            <span key={term.id} className={`term-chip${term.childTitle ? " term-child" : ""}`}>
              <button
                className="term-open"
                title={
                  term.childTitle ? t("childTerminal", term.childTitle) : t("revealTerminal")
                }
                onClick={() =>
                  vscode.postMessage({ type: "revealTerminal", terminalId: term.id })
                }
              >
                ❯_ {term.label}
                {term.childTitle ? " ⑂" : ""}
              </button>
              <button
                className="term-kill"
                title={t("killTerminal")}
                onClick={() => vscode.postMessage({ type: "killTerminal", terminalId: term.id })}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="card-actions">
        <button onClick={() => vscode.postMessage({ type: "run", promptId: card.id })}>
          {t("run")}
        </button>
        <button onClick={() => vscode.postMessage({ type: "generateChild", promptId: card.id })}>
          {t("generateChild")}
        </button>
        {card.workflowStatus === "Active" && (
          <button onClick={() => vscode.postMessage({ type: "advance", promptId: card.id })}>
            {t("advance")}
          </button>
        )}
        <button onClick={() => vscode.postMessage({ type: "addNote", promptId: card.id })}>
          {t("note")}
        </button>
        <button
          className="danger"
          onClick={() => vscode.postMessage({ type: "archive", promptId: card.id })}
        >
          {t("archive")}
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
        {column.droppable && cards.length === 0 && (
          <div className="column-empty">{t("dropHere")}</div>
        )}
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
          placeholder={t("search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
          <option value="notArchived">{t("notArchived")}</option>
          <option value="Draft">{t("draft")}</option>
          <option value="Ready">{t("ready")}</option>
          <option value="Archived">{t("archived")}</option>
        </select>
        <select value={flow} onChange={(event) => setFlow(event.target.value as WorkflowFilter)}>
          <option value="all">{t("allFlows")}</option>
          <option value="Active">{t("inProgress")}</option>
          <option value="Done">{t("doneFlows")}</option>
        </select>
        <button
          className="mode-toggle"
          onClick={() => setViewMode(viewMode === "kanban" ? "vertical" : "kanban")}
          title={t("modeToggleTitle")}
        >
          {viewMode === "kanban" ? t("modeVertical") : t("modeKanban")}
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
