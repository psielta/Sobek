<h1 align="center">🐊 Sobek</h1>

<p align="center">
  <strong>Prompt engineering workbench for AI coding agents, inside VS Code.</strong>
</p>

<p align="center">
  <a href="https://github.com/psielta/Sobek/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/psielta/Sobek/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.96-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

<p align="center">🇧🇷 <a href="https://github.com/psielta/Sobek/blob/main/README.pt-br.md">Versão em português</a></p>

Sobek is a VS Code extension to create, version and track Markdown prompts used with development agents like **Claude Code**, **Codex** and **Grok** — without leaving the editor. The open VS Code workspace is the target directory: prompts reference the project's real files, terminals spawn at the repository root, and a kanban board tracks each task from prompt engineering to merge.

The project ports the **core** of [Thoth](https://github.com/psielta/gerenciamento-de-tarefas-definidas-por-prompt) (a full-stack ASP.NET Core + React application) to a 100% local extension architecture: no backend, no database — state lives in versionable files under `.sobek/` in the workspace itself.

> In Egyptian mythology, Sobek guards boundaries — here, the guardian of your prompts, at the boundary between you and the agents.

## Features

### 📝 Prompts as first-class citizens
- Markdown prompts edited in VS Code's native editor, with an **immutable version history** on every content or status change (`Draft`, `Ready`, `Archived`).
- **`@file` mentions** with workspace file autocomplete (VS Code's own fuzzy scorer), real-time validation (diagnostics for broken references or paths escaping the workspace), clickable links and themed highlighting — in the editor, the child prompt preview and the rendered Markdown preview.
- Sidebar listing the **parent** prompts of each task; child prompts appear nested and open in a **read-only preview** — the editing context is always the parent's.

### 🌱 Template-generated child prompts
- Link a **Markdown plan** (e.g. a plan produced by Claude Code in plan mode) to a root prompt — from anywhere on disk.
- Linked plans are **watched and versioned**: every change to the plan file is captured as an immutable version. Open the plan from the prompt, browse the version history, diff any version against the previous one or the current file (VS Code's native diff), and pause/resume monitoring per prompt — archived prompts stop monitoring automatically.
- Generate auxiliary prompts from **9 templates** ported from Thoth: review plan (with or without the parent prompt as context), re-review, implement (including in a worktree), review PR, re-review PR with Codex's response, rebase and merge.
- PR references resolve in a cascade (input → PR stored on the plan) and persist for the next generation.
- **Workspace-defined custom templates**: author your own in `.sobek/templates/<slug>.md` (the *Create Custom Child Template* command scaffolds one). Frontmatter defines name, target agent, an optional `targetPhaseRole` (automatic parent phase advance) and custom inputs; the body uses the `{AbsolutePath}`, `{DisplayName}`, `{ParentPromptContent}`, `{PullRequestReference}` and `{input:key}` placeholders. Files hot-reload on save and are git-versionable.

### 📋 Workflow kanban
- Every root prompt is a task with a **10-phase workflow** (Prompt engineering → Planning → Plan review → ... → Commit/Merge), its own phase snapshot, a current owner (You/Claude/Codex/Grok) and an append-only timeline. Default phase names follow the VS Code display language.
- React webview board with **drag-and-drop** between phases, kanban/vertical modes, text/status/workflow filters and card actions (run, generate child, advance, note, archive).
- Cards show the task's **active terminals** (child prompt terminals included) as live chips — click to reveal the terminal, ✕ to kill it.
- **Automatic transitions**: creating a templated child prompt moves the parent to the matching phase; re-reviews increment the iteration (`re-review #2`); review verdicts move the task to the correction phase.

### 🖥️ Per-prompt terminals
- Native VS Code terminals opened at the workspace root, bound to the prompt, named and colored per agent — in the terminal panel or as **editor tabs**, your choice.
- Quick launch for **Claude, Claude Plan, Codex and Grok** with the right flags — `--effort` (up to `xhigh`/`max`) is your call per launch or pinned in settings, and Claude sessions can run in an **isolated git worktree** (`--worktree`, auto-named or named, per launch or pinned).
- Pick the **execution mode** per run: submit now (prompt passed as a CLI argument — it can never arrive truncated), stage as an unsent draft, Claude plan mode (`--permission-mode plan`) or just open the agent.
- A **Terminals view** groups every session by root prompt (child prompt terminals show under the parent with a "Child" badge); archiving a prompt kills its terminals; after creating a child prompt, Sobek offers to run it immediately.

### 📊 Agent usage indicators
- Status bar meters for **Claude Code and Codex usage limits**, read from the agents' local sources (Claude OAuth + Anthropic usage API; Codex session JSONL rate-limit snapshots).
- 5-hour, 7-day and per-model weekly windows (e.g. the Fable cap) with reset times; amber/red backgrounds at 70%/90%; click for the full breakdown panel.
- Activity-aware polling: wakes when you launch agents, sleeps when idle, refreshes the Codex meter as its sessions write.

### ✨ AI with Gemini
- **Refine prompt**: sends the content to Gemini with a specialized system instruction, shows the result as a **diff** and only applies on confirmation (creating a new version).
- **Prompt engineering assistant** in the sidebar, with streaming responses (including the model's reasoning), Markdown rendering, `@file` mentions with autocomplete, and the active prompt attached as context — visibly, via a context chip.
- Rich context injection (all toggleable): workspace convention files (`README.md`, `CLAUDE.md`, `AGENT.md`, `AGENTS.md`, `GEMINI.md`, Copilot instructions), files `@mentioned` in the prompt, the linked plan, the parent prompt, task workflow state and opt-in git context.
- Gemini 3.5/3.1/2.5 models with level- or budget-based reasoning, configurable temperature, and the API key stored in **SecretStorage** — never in project files.

## How it works

```text
<workspace>/
  .sobek/
    settings.json              Global workflow phase template
    templates/<slug>.md        Workspace-defined child prompt templates
    prompts/<id>/
      meta.json                Metadata, workflow (phases, timeline) and mentions
      prompt.md                Markdown content (edit it right in VS Code)
      versions.json            Immutable snapshots of every version
      plan-versions.json       Linked plan content snapshots (watcher-captured)
```

No external services beyond the (optional) Gemini API. The `.sobek/` directory can be committed to share tasks with your team — or ignored for local-only prompts.

## Architecture

```text
src/
  core/        Pure domain (prompt, workflow, templates, mentions) — fully unit-tested
  store/       File-backed persistence (.sobek/) with atomic writes
  terminals/   Agent launch semantics + manager over the native terminal API
  usage/       Claude/Codex usage limit readers
  ai/          Gemini client (REST + SSE), model catalog, system instructions
  language/    @mention completions, diagnostics, decorations, fuzzy file index
  ui/          Tree views, commands, board panel, chat view, refinement
  webview/     React apps (kanban board and assistant), themed via VS Code CSS vars
```

Principles:

- **Pure domain separated from the host**: workflow/template rules are functions with no VS Code dependency, covered by unit tests (Vitest).
- **Behavioral parity with Thoth**: enums, phases, template texts, system instructions and terminal semantics were ported verbatim.
- **Zero runtime dependencies**: the package ships only esbuild bundles; React exists only inside the webviews.
- **Localized**: UI follows the VS Code display language (English/Portuguese) via `package.nls`, `vscode.l10n` and webview dictionaries.

## Development

Prerequisites: Node.js 22+ and VS Code 1.96+.

```powershell
git clone https://github.com/psielta/Sobek.git
cd Sobek
npm install
npm run build      # bundles extension + webviews (esbuild)
```

Open the folder in VS Code and press **F5** (Run Extension) to load the extension in a development window.

Validation:

```powershell
npm run test       # Vitest (domain, store, templates, agents, usage)
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint
npm run package    # builds the .vsix with @vscode/vsce
```

To use the AI: `Ctrl+Shift+P` → **Sobek: Set Gemini API Key** (get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). Without a key, everything else works normally.

## Relationship to Thoth

| | Thoth | Sobek |
|---|---|---|
| Platform | ASP.NET Core + React (browser) | VS Code extension |
| Persistence | PostgreSQL + EF Core | Files under `.sobek/` |
| Workspace | Directory registration | The folder open in VS Code |
| Terminals | ConPTY + SignalR + xterm.js | Native terminal API |
| Real time | SignalR | Extension host events |
| AI | Gemini via backend | Gemini from the extension host |

## Roadmap

- Visual task timeline webview.
- Configurable task numbering (`TaskNumberPattern`).

## License

[MIT](LICENSE)
