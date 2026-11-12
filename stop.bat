@echo off
chcp 65001 >nul
setlocal
REM One-click stopper for tstock local services

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Node.js not found in PATH.
  pause
  exit /b 1
)

node "%~dp0scripts\local-service.mjs" stop %*
if %ERRORLEVEL% neq 0 (
  echo(%* | findstr /i "no-pause" >nul 2>nul || pause
  exit /b 1
)

exit /b 0
