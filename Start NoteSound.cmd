@echo off
setlocal
cd /d "%~dp0"
set "NOTESOUND_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NOTESOUND_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%NOTESOUND_NODE%" scripts\start-local.mjs %*
if errorlevel 1 pause
