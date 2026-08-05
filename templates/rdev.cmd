@echo off
setlocal
set "RDEV_NODE=node"
if defined RDEV_NODE_BIN set "RDEV_NODE=%RDEV_NODE_BIN%"
"%RDEV_NODE%" "%~dp0rdev-exec.mjs" %*
exit /b %ERRORLEVEL%
