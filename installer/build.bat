@echo off
chcp 65001 >nul 2>&1
REM Anthony AI Windows 安装器构建脚本
REM 必须在 Windows 上运行：cd installer && build.bat

setlocal
cd /d "%~dp0"

REM 定位 Inno Setup 6 Compiler
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"      set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if "%ISCC%"=="" (
  echo [X] 未找到 Inno Setup 6 Compiler ^(ISCC.exe^)
  echo     请从 https://jrsoftware.org/isdl.php 安装 Inno Setup 6 后重试
  pause
  exit /b 1
)

REM 内置 Windows Node 是安装包的强制组成部分
if not exist "..\plugin\runtime\node-win-x64\node.exe" (
  echo [X] 缺少 plugin\runtime\node-win-x64\node.exe
  echo     请在 plugin 目录执行: node tools\bundle-node.js
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo [X] 未找到 Git，无法把源码提交 SHA 写入安装完成标记
  pause
  exit /b 1
)
for /f "delims=" %%S in ('git -C ".." rev-parse HEAD') do set "SOURCE_COMMIT=%%S"
if "%SOURCE_COMMIT%"=="" (
  echo [X] 无法读取源码提交 SHA
  pause
  exit /b 1
)

echo [build] 运行 Windows 安装包静态门禁...
"..\plugin\runtime\node-win-x64\node.exe" "..\plugin\tools\validate-windows-package.js" ".."
if errorlevel 1 (
  echo [X] Windows 安装包静态门禁失败
  pause
  exit /b 1
)

echo [build] ISCC: %ISCC%
echo [build] SOURCE_COMMIT: %SOURCE_COMMIT%
echo [build] 正在编译 installer\anthony-ai.iss...
"%ISCC%" "/DSourceCommit=%SOURCE_COMMIT%" anthony-ai.iss
if errorlevel 1 (
  echo [X] 安装器编译失败
  pause
  exit /b 1
)

echo.
echo [build] 完成。安装器位于 dist\anthony-ai-*-setup.exe
pause
