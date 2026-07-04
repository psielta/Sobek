# CLAUDE.md

Instruções para Claude Code trabalhar neste projeto.

## Antes de Começar

1. Leia `README.md` e `AGENT.md` — as regras de produto e arquitetura estão lá e valem como contrato.
2. Verifique `git status --short`.
3. Entenda se a tarefa pede somente plano, revisão ou implementação.

## Sobre o Projeto

Sobek é uma extensão VS Code (TypeScript + esbuild + React nos webviews) que porta o core do Thoth: prompts Markdown versionados, prompts filhos por template, kanban de workflow, terminais por prompt e IA Gemini. O workspace aberto é o diretório alvo; o estado fica em `.sobek/`.

## Regras que Não Devem Ser Quebradas

- Tree view lista apenas prompts pai; filho abre preview somente leitura, nunca edição.
- Filho criado com `sourceTemplateKey` avança o workflow do pai (mapa template→fase em `src/core/templates.ts`).
- Concluir workflow não arquiva o prompt; arquivar mata os terminais do prompt.
- Menções `@arquivo` validadas contra o workspace (sem absoluto, sem `..`).
- Módulos puros (`src/core/`, `src/terminals/agents.ts`, `src/ai/instructions.ts`, `src/ai/gemini-client.ts`) não importam `vscode`.
- Chave Gemini apenas em SecretStorage.
- Textos de template e instruções de sistema são portados verbatim do Thoth — não os "melhore" sem pedido explícito.

## Como Planejar Mudanças

Planos devem citar arquivos reais (`src/core/workflow.ts`, `src/store/prompt-store.ts`, `src/ui/board-panel.ts`, `package.json` contributes...), impacto em domínio/UI/webview/manifest e critérios de validação com comandos exatos.

## Validação

```powershell
npm run build
npm run typecheck
npm run lint
npm run test
```

Mudanças de UI: validar via F5 (Run Extension). Mudanças de manifest: `npm run package`.

## Commits

- Conventional Commits, **sem** linha `Co-Authored-By`.
- Um commit por mudança lógica; ao terminar cada tarefa, commit + push.
- Auto-close de issues só com palavra-chave em inglês (`Closes #N`).
