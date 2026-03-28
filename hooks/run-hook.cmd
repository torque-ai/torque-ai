@REM :; exec bash "$0" "$@"
@echo off
setlocal enabledelayedexpansion

REM Windows CMD path
set "SCRIPT_DIR=%~dp0"
set "HOOK_NAME=%~1"

REM Try Git Bash first
where git >nul 2>nul && (
  for /f "delims=" %%i in ('where git') do set "GIT_PATH=%%~dpi"
  set "GIT_BASH=!GIT_PATH!..\bin\bash.exe"
  if exist "!GIT_BASH!" (
    "!GIT_BASH!" "%SCRIPT_DIR%%HOOK_NAME%" %*
    exit /b %errorlevel%
  )
)

REM Fallback to WSL
wsl bash "%SCRIPT_DIR%%HOOK_NAME%" %*
exit /b %errorlevel%

REM --- Unix bash path (reached via exec bash above) ---
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_NAME="${1}"
shift
exec bash "${SCRIPT_DIR}/${HOOK_NAME}" "$@"
