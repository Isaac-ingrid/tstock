@echo off
REM ============================================================
REM timing_task/stop.bat —— Windows 定时调度器停止脚本
REM ============================================================
chcp 65001 >nul
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
cd /d "%ROOT_DIR%"

node "%SCRIPT_DIR%stop.js"
