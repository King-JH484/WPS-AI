@echo off
REM 一键编译灵犀AI Windows 安装器
REM 用法：双击此文件,或终端 cd installer && build.bat
REM 前置：
REM   1. 装 Inno Setup Compiler  https://jrsoftware.org/isdl.php
REM   2. 先跑 cd plugin && node tools\bundle-node.js 下好 portable Node

setlocal
cd /d "%~dp0"

REM 找 ISCC.exe
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"      set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe"

if "%ISCC%"=="" (
  echo [X] 没找到 Inno Setup Compiler ^(ISCC.exe^)。
  echo     请去 https://jrsoftware.org/isdl.php 下载 Inno Setup 6 安装。
  pause
  exit /b 1
)

REM 校验 runtime/ 已就绪
if not exist "..\plugin\runtime\node-win-x64\node.exe" (
  echo [X] plugin\runtime\node-win-x64\node.exe 不存在。
  echo     请先在 plugin 目录跑: node tools\bundle-node.js
  pause
  exit /b 1
)

echo [build] ISCC: %ISCC%
echo [build] 编译 installer\lingxi-ai.iss...
"%ISCC%" lingxi-ai.iss
if errorlevel 1 (
  echo [X] 编译失败
  pause
  exit /b 1
)

echo.
echo [build] 完成。产物在 dist\lingxi-ai-*-setup.exe
pause
