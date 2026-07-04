<h1 align="center">🐊 Sobek</h1>

<p align="center">
  <strong>Workbench de engenharia de prompts para agentes de código, dentro do VS Code.</strong>
</p>

<p align="center">
  <a href="https://github.com/psielta/Sobek/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/psielta/Sobek/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-%5E1.96-007ACC?logo=visualstudiocode&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
</p>

Sobek é uma extensão do VS Code para criar, versionar e acompanhar prompts em Markdown usados com agentes de desenvolvimento como **Claude Code**, **Codex** e **Grok** — sem sair do editor. O workspace aberto no VS Code já é o diretório alvo: os prompts referenciam os arquivos reais do projeto, os terminais nascem na raiz do repositório e o board kanban acompanha cada tarefa da engenharia do prompt até o merge.

O projeto porta o **core** do [Thoth](https://github.com/psielta/gerenciamento-de-tarefas-definidas-por-prompt) (aplicação full-stack ASP.NET Core + React) para uma arquitetura 100% local de extensão: sem backend, sem banco — o estado vive em arquivos versionáveis dentro de `.sobek/` no próprio workspace.

> Na mitologia egípcia, Sobek é o guardião de fronteiras — aqui, o guardião dos seus prompts, na fronteira entre você e os agentes.

## Recursos

### 📝 Prompts como cidadãos de primeira classe
- Prompts em Markdown editados no editor nativo do VS Code, com **histórico de versões imutável** a cada alteração de conteúdo ou status (`Rascunho`, `Pronto`, `Arquivado`).
- **Menções `@arquivo`** com autocomplete dos arquivos do workspace, validação em tempo real (diagnostics para referências quebradas ou que escapam do diretório) e links clicáveis.
- Sidebar com os prompts **pai** da tarefa; prompts filhos aparecem aninhados e abrem em **preview somente leitura** — o contexto de edição é sempre o do pai.

### 🌱 Prompts filhos gerados por template
- Vincule um **plano Markdown** (ex.: plano gerado pelo Claude Code em plan-mode) a um prompt raiz.
- Gere prompts auxiliares a partir de **9 templates** portados do Thoth: revisar plano (com ou sem o prompt pai como contexto), re-review, implementar (inclusive em worktree), revisar PR, re-review de PR com a resposta do Codex, rebase e merge.
- Referências de PR são resolvidas em cascata (input → PR salva no plano) e persistidas para a próxima geração.

### 📋 Kanban de workflow
- Cada prompt raiz é uma tarefa com **workflow de 10 fases** (Engenharia de prompt → Planejamento → Revisão do plano → ... → Commit/Merge), snapshot próprio de fases, responsável atual (Você/Claude/Codex/Grok) e timeline append-only.
- Board em webview React com **drag-and-drop** entre fases, modos kanban/vertical, filtros por texto/status/fluxo e ações no cartão (gerar filho, avançar, nota, arquivar).
- **Transições automáticas**: criar um prompt filho de template move o pai para a fase correspondente; re-reviews incrementam a iteração (`re-review #2`); vereditos de revisão movem a tarefa para a fase de correção.

### 🖥️ Terminais por prompt
- Terminais nativos do VS Code abertos na raiz do workspace, associados ao prompt, com nome e cor por agente.
- Lançamento rápido de **Claude, Claude Plan, Codex e Grok** com os flags corretos; o conteúdo do prompt é achatado para uma linha e submetido ao CLI — ou, no plan-mode, preenchido como **rascunho não enviado** para revisão.
- Arquivar um prompt encerra seus terminais; após criar um prompt filho, o Sobek oferece abrir o agente alvo já executando o prompt.

### ✨ IA com Gemini
- **Refinar prompt**: envia o conteúdo para o Gemini com instrução de sistema especializada, mostra o resultado como **diff** e só aplica com confirmação (gerando nova versão).
- **Assistente de engenharia de prompts** na sidebar, com streaming de resposta (incluindo o raciocínio do modelo), opção de anexar o prompt aberto como contexto e atalhos para configuração.
- Modelos Gemini 3.5/3.1/2.5 com raciocínio por **nível** ou **budget de tokens**, temperatura configurável, contexto opcional do workspace (`README.md`, `CLAUDE.md`, `AGENT.md`) e chave de API guardada em **SecretStorage** — nunca em arquivos do projeto.

## Como funciona

```text
<workspace>/
  .sobek/
    settings.json              Template global de fases do workflow
    prompts/<id>/
      meta.json                Metadados, workflow (fases, timeline) e menções
      prompt.md                Conteúdo Markdown (edite no próprio VS Code)
      versions.json            Snapshots imutáveis de cada versão
```

Sem serviços externos além da Gemini API (opcional). O diretório `.sobek/` pode ser commitado para compartilhar as tarefas com o time — ou ignorado, se preferir prompts locais.

## Arquitetura

```text
src/
  core/        Domínio puro (prompt, workflow, templates, menções) — 100% testável
  store/       Persistência em arquivos (.sobek/) com escrita atômica
  terminals/   Semântica de agentes + gerenciador sobre a API nativa de terminais
  ai/          Cliente Gemini (REST + SSE), catálogo de modelos, instruções de sistema
  ui/          Tree view, comandos, board panel, chat view, refinamento
  webview/     Apps React (board kanban e assistente), tema via variáveis do VS Code
```

Princípios:

- **Domínio puro separado do host**: regras de workflow/templates são funções sem dependência do VS Code, cobertas por testes unitários (Vitest).
- **Paridade comportamental com o Thoth**: enums, fases, textos de template, instruções de sistema e semântica de terminal foram portados verbatim.
- **Zero dependências de runtime**: o pacote publica apenas os bundles do esbuild; React existe só nos webviews.

## Desenvolvimento

Pré-requisitos: Node.js 22+ e VS Code 1.96+.

```powershell
git clone https://github.com/psielta/Sobek.git
cd Sobek
npm install
npm run build      # bundla extensão + webviews (esbuild)
```

Abra a pasta no VS Code e pressione **F5** (Run Extension) para carregar a extensão em uma janela de desenvolvimento.

Validação:

```powershell
npm run test       # Vitest (domínio, store, templates, agentes)
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint
npm run package    # gera o .vsix com @vscode/vsce
```

Para usar a IA: `Ctrl+Shift+P` → **Sobek: Configurar chave Gemini** (obtenha a chave em [aistudio.google.com/apikey](https://aistudio.google.com/apikey)). Sem chave, o restante da extensão funciona normalmente.

## Relação com o Thoth

| | Thoth | Sobek |
|---|---|---|
| Plataforma | ASP.NET Core + React (navegador) | Extensão VS Code |
| Persistência | PostgreSQL + EF Core | Arquivos em `.sobek/` |
| Workspace | Cadastro de diretórios | A pasta aberta no VS Code |
| Terminais | ConPTY + SignalR + xterm.js | API nativa de terminais |
| Tempo real | SignalR | Eventos do extension host |
| IA | Gemini via backend | Gemini direto do extension host |

## Roadmap

- Watcher do plano vinculado com versionamento automático (paridade com os *linked documents* do Thoth).
- Timeline visual da tarefa em webview.
- Numeração de tarefas configurável (`TaskNumberPattern`).
- Publicação no Marketplace / Open VSX.

## Licença

[MIT](LICENSE)
