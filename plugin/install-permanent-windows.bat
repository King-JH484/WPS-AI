@echo off
chcp 65001 >nul 2>&1
setlocal
title Anthony AI Windows 源码安装

set "PLUGIN_DIR=%~dp0"
if "%PLUGIN_DIR:~-1%"=="\" set "PLUGIN_DIR=%PLUGIN_DIR:~0,-1%"
for %%I in ("%PLUGIN_DIR%\..") do set "REPO_DIR=%%~fI"

echo ============================================
echo   Anthony AI Windows 源码安装
echo ============================================
echo   本入口不会再创建旧式 Run/VBS 服务。
echo   它会构建并运行与正式分发一致的 Inno Setup 安装器。
echo.

if not exist "%REPO_DIR%\installer\build.bat" (
  echo [X] 仓库结构不完整: %REPO_DIR%
  goto :hold
)

call "%REPO_DIR%\installer\build.bat"
if errorlevel 1 (
  echo [X] 安装器构建失败
  goto :hold
)

set "SETUP_EXE="
for /f "delims=" %%F in ('dir /b /a-d /o-d "%REPO_DIR%\dist\anthony-ai-*-setup.exe" 2^>nul') do if not defined SETUP_EXE set "SETUP_EXE=%REPO_DIR%\dist\%%F"
if not defined SETUP_EXE (
  echo [X] 构建完成但没有找到 dist\anthony-ai-*-setup.exe
  goto :hold
)

echo [install] 运行: %SETUP_EXE%
start "" /wait "%SETUP_EXE%"
if errorlevel 1 (
  echo [X] 安装器返回失败
  goto :hold
)

echo [OK] 安装器已结束。请按 Windows 交接文档继续完成真机验收。

:hold
echo.
echo 窗口保持打开。阅读输出后请点击右上角 X 关闭。
:hold_loop
timeout /t 3600 /nobreak >nul 2>&1
goto :hold_loop
