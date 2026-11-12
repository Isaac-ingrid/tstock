@echo off
chcp 65001 >nul
setlocal
REM One-click launcher for tstock local services (backend:18765, frontend:3000, timing_task)

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Node.js not found in PATH. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\local-service.mjs" start %*
if %ERRORLEVEL% neq 0 (
  echo.
  echo [HINT] Startup did not finish. Check logs above or in .\logs\
  echo(%* | findstr /i "no-pause" >nul 2>nul || pause
  exit /b 1
)

exit /b 0
