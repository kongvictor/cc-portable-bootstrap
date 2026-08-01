@echo off
setlocal
set "CLAUDEX_POWERSHELL=powershell.exe"
where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 set "CLAUDEX_POWERSHELL=pwsh.exe"
set "CLAUDEX_NODE=node"
if defined CLAUDEX_NODE_BIN set "CLAUDEX_NODE=%CLAUDEX_NODE_BIN%"
"%CLAUDEX_NODE%" "%~dp0claudex-exec.mjs" --powershell-launcher "%CLAUDEX_POWERSHELL%" "%~dp0claudex.ps1" %*
exit /b %ERRORLEVEL%
