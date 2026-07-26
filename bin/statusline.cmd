@echo off
setlocal

set "Runtime=%~dp0runtime.mjs"
if not exist "%Runtime%" set "Runtime=%~dp0..\core\statusline\runtime.mjs"
if not exist "%Runtime%" exit /b 0

set "NodeBin=%CC_BOOTSTRAP_NODE_BIN%"
if not defined NodeBin set "NodeBin=%CLIPROXY_NODE_BIN%"
if not defined NodeBin if exist "%~dp0.node-path" set /p "NodeBin="<"%~dp0.node-path"
if not defined NodeBin set "NodeBin=node"

if exist "%NodeBin%" goto run
where.exe "%NodeBin%" >nul 2>nul || exit /b 0

:run
"%NodeBin%" "%Runtime%"
exit /b %ERRORLEVEL%
