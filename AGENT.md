# AGENT.md

Guia operacional para agentes de código trabalhando neste repositório.

## Contexto do Projeto

Sobek é uma extensão do VS Code que porta o core do Thoth (gerenciador de prompts para Claude Code/Codex) para uma arquitetura local-first: criação e versionamento de prompts Markdown, prompts filhos gerados por template, kanban de workflow, terminais associados a prompts e IA Gemini para refinamento/chat. O workspace aberto no VS Code é o diretório alvo; o estado vive em `.sobek/` na raiz do workspace.

Trate este repositório como projeto de portfólio: preserve clareza arquitetural, paridade comportamental com o Thoth e cobertura de testes do domínio.

## Regras de Produto (invariantes)

- A listagem principal (tree view) mostra somente prompts pai; filhos aparecem aninhados sob o pai.
- Clicar em um prompt filho abre preview somente leitura (`sobek-child:` scheme); nunca abra o filho como superfície de edição.
- Prompts filhos são gerados a partir de um plano Markdown vinculado ao pai e nunca têm workflow próprio.
- Criar um filho com `sourceTemplateKey` avança o workflow do PAI para a fase do `targetPhaseRole` do template (quando definido); re-reviews incrementam `currentPhaseIteration`.
- Templates personalizados vivem em `.sobek/templates/<slug>.md` (frontmatter + corpo com placeholders; parser em `src/core/custom-templates.ts`) e usam `custom:<slug>` como `sourceTemplateKey`. Os 9 built-ins em `src/core/templates.ts` permanecem verbatim do Thoth — não os altere.
- Menções `@arquivo` devem resolver dentro do workspace (sem paths absolutos, sem `..`); referência inexistente gera warning mas não bloqueia salvar.
- Toda mudança de conteúdo ou status cria uma `PromptVersion` imutável e incrementa `currentVersion`.
- Concluir o workflow NÃO arquiva o prompt: `Prompt.status` e `Workflow.status` são eixos independentes.
- Arquivar um prompt encerra seus terminais (evento `onDidArchive` do store) e impede novos terminais.
- Comandos de agente nos terminais são fixos: `claude --dangerously-skip-permissions --effort max`, `codex --yolo`, `grok --always-approve`. Claude Plan injeta o prompt achatado como rascunho SEM Enter; execução de prompt submete a linha achatada.
- A chave Gemini vive apenas no SecretStorage; nunca a escreva em arquivos ou settings.

## Arquitetura

- `src/core/` — domínio puro (sem `vscode`): prompt, workflow (fases/eventos), templates de filho, menções. Qualquer regra nova de negócio entra aqui, com testes.
- `src/store/` — persistência em arquivos sob `.sobek/` (escrita atômica via rename). `PromptStore` é a única porta de mutação; eventos `onDidChange`/`onDidArchive` alimentam UI e efeitos colaterais.
- `src/terminals/` — semântica de agentes (pura, testada) + `TerminalManager` sobre `vscode.window.createTerminal`.
- `src/ai/` — cliente Gemini REST/SSE, catálogo de modelos, instruções de sistema verbatim do Thoth, leitura de contexto do workspace.
- `src/ui/` — tree provider, comandos, painel do board, view do assistente, refinamento.
- `src/webview/` — apps React bundlados separadamente (board, assistant); tema exclusivamente via variáveis CSS `--vscode-*`; comunicação por `postMessage` tipada.

Regras de estrutura:

- Não importe `vscode` em `src/core/`, `src/ai/gemini-client.ts`, `src/ai/instructions.ts` ou `src/terminals/agents.ts` — são módulos puros/testáveis.
- Webviews não acessam filesystem/rede: todo dado chega por mensagem do extension host.
- Novos comandos exigem registro em `package.json` (`contributes.commands` + menus) e em um módulo de `src/ui/`.
- Textos de UI em pt-BR, consistentes com o Thoth.

## Comandos de Desenvolvimento

```powershell
npm install
npm run build       # esbuild: extensão (dist/extension.js) + webviews (dist/webview/*)
npm run watch       # build incremental
npm run test        # Vitest
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint flat config
npm run package     # vsce package (.vsix)
```

Depuração: abra a pasta no VS Code e use **F5** (launch config "Run Extension").

## Validação Esperada

Para qualquer mudança: `npm run build && npm run typecheck && npm run lint && npm run test`.

- Mudou domínio/store → adicione/atualize testes unitários correspondentes.
- Mudou UI/webview → valide manualmente via F5 (tree, board, chat) antes de concluir.
- Mudou manifest (`package.json`) → confirme que `npm run package` continua gerando o `.vsix`.

## Commits

- Sempre Conventional Commits (`feat(escopo): ...`, `fix: ...`, `docs: ...`), **sem** linha `Co-Authored-By`.
- Commits separados por mudança lógica; termine cada tarefa com commit + push.
- Para fechar issue via commit, use palavra-chave em inglês (`Closes #N`, `Fixes #N`); termos em português não acionam o auto-close.
