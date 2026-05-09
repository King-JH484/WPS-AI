@echo off
setlocal enabledelayedexpansion
title 灵犀AI 永久安装（Windows）

echo ============================================
echo   灵犀AI WPS 插件 - Windows 永久安装
echo ============================================
echo   会一次性给三个 WPS 应用（文字/表格/演示）注册插件，
echo   并把后台服务加到登录时自动启动。
echo.

REM --- 检查 Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [X] 未检测到 Node.js。请先安装：https://nodejs.org/zh-cn/
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js: %%v

REM --- 计算源目录与目标目录 ---
set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"
set "TARGET=%USERPROFILE%\.lingxi-ai"

echo [..] 源目录: %SRC_DIR%
echo [..] 目标目录: %TARGET%
echo.

REM --- 1. 生成三宿主变体到 ../dist-permanent ---
echo [1/5] 生成三个宿主变体（plugin-wps / plugin-et / plugin-wpp）...
pushd "%SRC_DIR%"
node tools\build-variants.js --out "%TARGET%"
if errorlevel 1 (
  echo [X] 生成宿主变体失败
  popd
  pause
  exit /b 1
)
popd

REM --- 2. 把 serve-permanent.js + proxy-server.js 也放到目标目录的 tools/ ---
echo [2/5] 复制常驻服务脚本...
if not exist "%TARGET%\tools" mkdir "%TARGET%\tools"
copy /Y "%SRC_DIR%\tools\serve-permanent.js" "%TARGET%\tools\serve-permanent.js" >nul
copy /Y "%SRC_DIR%\tools\proxy-server.js" "%TARGET%\tools\proxy-server.js" >nul
echo [OK] 服务脚本已就位

REM --- 3. 写 publish.xml 注册三个宿主 ---
echo [3/5] 写入 WPS 加载项注册（publish.xml）...
set "JSADDONS=%APPDATA%\kingsoft\wps\jsaddons"
if not exist "%JSADDONS%" mkdir "%JSADDONS%"
set "PUBLISH=%JSADDONS%\publish.xml"
(
  echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
  echo ^<jsplugins^>
  echo   ^<jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" debug="" enable="enable_dev" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  debug="" enable="enable_dev" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" debug="" enable="enable_dev" install="null"/^>
  echo ^</jsplugins^>
) > "%PUBLISH%"
echo [OK] %PUBLISH%

REM --- 4. 写一个最小版的启动脚本（隐藏窗口）---
echo [4/5] 生成静默启动脚本...
set "RUN_BAT=%TARGET%\run-server-hidden.vbs"
> "%RUN_BAT%" echo Set ws = CreateObject("Wscript.Shell")
>>"%RUN_BAT%" echo ws.Run "cmd /c node """%TARGET%\tools\serve-permanent.js""" --root """%TARGET%""" >> ""%TARGET%\server.log"" 2>^&1", 0, False
echo [OK] %RUN_BAT%

REM 同时再生成一个可见窗口的脚本，便于排查
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
> "%DEBUG_BAT%" echo @echo off
>>"%DEBUG_BAT%" echo title 灵犀AI 后台服务（调试模式）
>>"%DEBUG_BAT%" echo node "%TARGET%\tools\serve-permanent.js" --root "%TARGET%"

REM --- 5. 注册登录时自动启动（Task Scheduler）---
echo [5/5] 注册登录时自动启动（计划任务 LingxiAI）...
schtasks /Query /TN "LingxiAI" >nul 2>&1
if not errorlevel 1 (
  schtasks /Delete /TN "LingxiAI" /F >nul 2>&1
)
schtasks /Create /TN "LingxiAI" /SC ONLOGON /RL LIMITED /TR "wscript.exe \"%RUN_BAT%\"" /F >nul
if errorlevel 1 (
  echo [!] 计划任务注册失败（可能权限不足），请手动双击 %DEBUG_BAT% 临时启动服务
) else (
  echo [OK] 已注册计划任务 LingxiAI（下次登录起自动跑）
)

REM 立即启动一次，省得等下次登录
start "" wscript.exe "%RUN_BAT%"

echo.
echo ============================================
echo   永久安装完成！
echo ============================================
echo   后台服务已启动：http://127.0.0.1:3889 / :3890
echo   日志输出：%TARGET%\server.log
echo.
echo   下一步：
echo     1. 完全退出 WPS（任务栏图标右键退出）
echo     2. 重新打开 WPS 文字 / 表格 / 演示，顶部应出现「灵犀AI」
echo     3. 不需要保留任何终端窗口，服务后台跑
echo.
echo   卸载：双击 uninstall-permanent-windows.bat
echo ============================================
pause
