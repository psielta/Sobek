@echo off
REM Compila a extensao e abre o Extension Development Host (equivalente ao F5)
REM apontando para .sandbox\ - um workspace de teste persistente e fora do git.
setlocal
pushd "%~dp0"

echo [sobek] build...
call npm run build
if errorlevel 1 (
  echo [sobek] build falhou - corrija os erros acima.
  popd
  exit /b 1
)

set "WS=%~dp0.sandbox"
if not exist "%WS%\media\icons" mkdir "%WS%\media\icons"
if not exist "%WS%\src\core" mkdir "%WS%\src\core"
if not exist "%WS%\src\ui" mkdir "%WS%\src\ui"
if not exist "%WS%\docs" mkdir "%WS%\docs"
if not exist "%WS%\README.md" echo # sandbox> "%WS%\README.md"
if not exist "%WS%\media\logo.png" echo logo> "%WS%\media\logo.png"
if not exist "%WS%\media\style.css" echo body{}> "%WS%\media\style.css"
if not exist "%WS%\media\icons\app.svg" echo icon> "%WS%\media\icons\app.svg"
if not exist "%WS%\src\core\engine.ts" echo export {}> "%WS%\src\core\engine.ts"
if not exist "%WS%\src\core\utils.ts" echo export {}> "%WS%\src\core\utils.ts"
if not exist "%WS%\src\ui\panel.ts" echo export {}> "%WS%\src\ui\panel.ts"
if not exist "%WS%\docs\plano.md" echo # plano> "%WS%\docs\plano.md"

echo [sobek] abrindo Extension Development Host...
call code --extensionDevelopmentPath="%~dp0." "%WS%"
popd
endlocal
