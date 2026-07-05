# AGENT.md

Guia operacional para agentes de código trabalhando neste repositório.

## Contexto do Projeto

Sobek é uma extensão do VS Code que porta o core do Thoth (gerenciador de prompts para Claude Code/Codex) para uma arquitetura local-first: criação e versionamento de prompts Markdown, prompts filhos gerados por template, kanban de workflow, terminais associados a prompts e IA Gemini para refinamento/chat. O workspace aberto no VS Code é o diretório alvo; o estado vive em `.sobek/` na raiz do workspace.

Trate este repositório como projeto de portfólio: preserve clareza arquitetural, paridade comportamental com o Thoth e cobertura de testes do domínio.

## Regras de Produto (invariantes)

- A listagem principal (tree view) mostra somente prompts pai; filhos aparecem aninhados sob o pai.
- Clicar em um prompt filho abre preview somente leitura (`sobek-child:` scheme); nunca abra o filho como superfície de edição.
- Prompts filhos são gerados a partir de um plano Markdown vinculado ao pai e nunca têm workflow próprio.
- Planos vinculados mantêm histórico versionado (`prompts/<id>/plan-versions.json`): o `PlanWatcherManager` captura uma versão a cada mudança de conteúdo do arquivo. Prompt arquivado NÃO continua monitorando o plano; o monitoramento pode ser pausado/retomado por prompt (`linkedPlan.monitoringPaused`). Trocar o arquivo do plano reseta o histórico; desvincular o descarta.
- Criar um filho com `sourceTemplateKey` avança o workflow do PAI para a fase do `targetPhaseRole` do template (quando definido); re-reviews incrementam `currentPhaseIteration`.
- Templates personalizados vivem em `.sobek/templates/<slug>.md` (frontmatter + corpo com placeholders; parser em `src/core/custom-templates.ts`) e usam `custom:<slug>` como `sourceTemplateKey`. Os 9 built-ins em `src/core/templates.ts` permanecem verbatim do Thoth — não os altere.
- Menções `@arquivo` devem resolver dentro do workspace (sem paths absolutos, sem `..`); referência inexistente gera warning mas não bloqueia salvar.
- Toda mudança de conteúdo ou status cria uma `PromptVersion` imutável e incrementa `currentVersion`.
- Concluir o workflow NÃO arquiva o prompt: `Prompt.status` e `Workflow.status` são eixos independentes.
- Arquivar um prompt encerra seus terminais (evento `onDidArchive` do store) e impede novos terminais.
- Comandos base dos agentes nos terminais: `claude --dangerously-skip-permissions`, `codex --yolo`, `grok --always-approve`; `--effort` é opcional (escolha por lançamento ou fixado nas settings, em `src/terminals/agents.ts`). Executar/plan passa o prompt como argumento posicional do CLI; "preencher como rascunho" digita o prompt achatado SEM Enter.
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

## Publicação (Marketplace + Open VSX)

Tokens locais em `.env` na raiz do repo (**nunca commitado**; nunca imprima os valores):
- `PERSONAL_ACCESS_TOKEN` — Azure DevOps PAT (scope Marketplace → Manage) do publisher `psielta`.
- `OPEN_VSX_TOKEN` — token do Open VSX (o namespace precisa ser `psielta`, igual ao campo `publisher` do package.json; foi criado via `npx ovsx create-namespace psielta`).

Fluxo preferido — release por tag (o workflow `.github/workflows/release.yml` publica nos dois marketplaces usando os secrets `VSCE_PAT` e `OVSX_TOKEN` do repositório GitHub):

```powershell
npm version patch          # ou minor/major — atualiza package.json e cria a tag vX.Y.Z
git push --follow-tags
```

Fluxo manual (mesma versão do package.json; `vscode:prepublish` roda o build de produção automaticamente):

```powershell
$envs = Get-Content .env | ConvertFrom-StringData
npx vsce publish -p $envs.PERSONAL_ACCESS_TOKEN
npx ovsx publish -p $envs.OPEN_VSX_TOKEN
```

Antes de publicar: CI verde, versão bumpada (o Marketplace rejeita republicar a mesma versão) e `npm run package` gerando o `.vsix` sem erros. Páginas: `marketplace.visualstudio.com/items?itemName=psielta.sobek` e `open-vsx.org/extension/psielta/sobek`.

## Commits

- Sempre Conventional Commits (`feat(escopo): ...`, `fix: ...`, `docs: ...`), **sem** linha `Co-Authored-By`.
- Commits separados por mudança lógica; termine cada tarefa com commit + push.
- Para fechar issue via commit, use palavra-chave em inglês (`Closes #N`, `Fixes #N`); termos em português não acionam o auto-close.
