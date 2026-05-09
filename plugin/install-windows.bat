@echo off
setlocal enabledelayedexpansion
title 灵犀AI 插件安装

echo ============================================
echo   灵犀AI WPS 插件 - Windows 安装脚本
echo ============================================
echo.

REM --- 检查 Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [X] 未检测到 Node.js。
  echo     请先安装 Node.js LTS 版本：https://nodejs.org/zh-cn/
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js: %NODE_VER%

REM --- 检查 npm ---
where npm >nul 2>&1
if errorlevel 1 (
  echo [X] 未检测到 npm（通常随 Node.js 一起安装）
  pause
  exit /b 1
)
for /f "delims=" %%v in ('npm -v') do set NPM_VER=%%v
echo [OK] npm: %NPM_VER%

REM --- 检查 wpsjs（必要 CLI）---
where wpsjs >nul 2>&1
if errorlevel 1 (
  echo [..] 未检测到 wpsjs，正在全局安装...
  call npm install -g wpsjs
  if errorlevel 1 (
    echo [X] wpsjs 全局安装失败。请手动执行：npm install -g wpsjs
    pause
    exit /b 1
  )
)
echo [OK] wpsjs 已就绪

REM --- 安装项目依赖 ---
echo.
echo [..] 正在安装项目依赖（npm install）...
call npm install
if errorlevel 1 (
  echo [X] npm install 失败
  pause
  exit /b 1
)
echo [OK] 依赖安装完成

echo.
echo ============================================
echo   安装完成！下一步：
echo ============================================
echo   1. 启动调试 / 注册到 WPS：双击 start-wps.bat（文字）/ start-et.bat（表格）/ start-wpp.bat（演示）
echo   2. 打开对应的 WPS 应用，顶部功能区会出现「灵犀AI」
echo   3. 关闭脚本（Ctrl-C）即停止；下次使用直接再次双击对应 start-*.bat
echo ============================================
pause
