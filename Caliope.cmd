@echo off
rem Starts Caliope. Looks for Node.js 22.15+ in this order:
rem   1. runtime\node.exe next to this file (included in the release zip)
rem   2. node.exe on PATH
rem   3. the Node.js the Codex app keeps (to run from source on a PC without Node.js on PATH)
setlocal EnableExtensions
set "APP=%~dp0"
rem Files from a downloaded zip carry a "from the internet" mark, so Windows warns before every start.
rem Remove it once from the whole folder.
set "CALIOPE_APP=%APP%"
(more < "%~f0:Zone.Identifier") >nul 2>nul && powershell -NoProfile -NonInteractive -Command "Get-ChildItem -LiteralPath $env:CALIOPE_APP -Recurse -File | Unblock-File"
set "NODE="
if exist "%APP%runtime\node.exe" set "NODE=%APP%runtime\node.exe"
rem A Node.js on PATH counts only when it is 22.15 or newer; otherwise the next place is tried.
if not defined NODE for /f "delims=" %%N in ('where node 2^>nul') do (
  if not defined NODE "%%N" -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 15) ? 0 : 1)" >nul 2>nul && set "NODE=%%N"
)
if not defined NODE for /d %%R in ("%USERPROFILE%\.cache\codex-runtimes\*") do (
  if not defined NODE if exist "%%~R\dependencies\node\bin\node.exe" set "NODE=%%~R\dependencies\node\bin\node.exe"
)
if not defined NODE (
  powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Caliope needs Node.js 22.15 or newer. Download the Caliope zip that includes Node.js.', 'Caliope', 'OK', 'Error')"
  exit /b 1
)
"%NODE%" --use-system-ca "%APP%server\main.js" --open --detach
rem Caliope shows its own errors and then exits with 1. Anything else means Node.js did not run at all,
rem for example because the company blocks programs in user folders (AppLocker): say so instead of closing.
if errorlevel 2 (
  set "CALIOPE_NODE=%NODE%"
  set "CALIOPE_CODE=%ERRORLEVEL%"
  powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show(('Windows did not start Node.js for Caliope (error ' + $env:CALIOPE_CODE + '):' + [Environment]::NewLine + $env:CALIOPE_NODE + [Environment]::NewLine + [Environment]::NewLine + 'If your company blocks programs in your user folder, ask your IT department to allow it.'), 'Caliope', 'OK', 'Error')"
  exit /b 1
)
