@echo off
REM ============================================================
REM timing_task/start.bat —— Windows 定时调度器启动脚本
REM ============================================================
chcp 65001 >nul
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
cd /d "%ROOT_DIR%"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [错误] 未检测到 node 环境，请先安装 Node.js。
  pause
  exit /b 1
)

echo 正在启动 A股做T执行台定时调度服务...
node "%SCRIPT_DIR%start.js"
if %ERRORLEVEL% neq 0 (
  echo 启动失败，请检查上方日志输出。
) else (
  echo.
  echo [提示] 调度器已在后台运行。
  echo 查询状态: node timing_task\status.js
  echo 停止服务: timing_task\stop.bat
)
