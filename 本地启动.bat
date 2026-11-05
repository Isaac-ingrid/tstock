@echo off
chcp 65001 >nul
title A股做T执行台 (Vite 极速开发服务)
cd /d "%~dp0"
echo ============================================================
echo   A股做T执行台 · Vite 极速开发服务启动中...
echo   访问地址: http://localhost:5173
echo   支持模块化 HMR 热重载与官方 Anime.js v4 动效
echo ============================================================
npm run dev
pause
