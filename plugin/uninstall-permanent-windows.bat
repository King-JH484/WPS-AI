@echo off
title 灵犀AI 永久卸载（Windows）

echo ============================================
echo   灵犀AI 永久卸载
echo ============================================
echo.

set "TARGET=%USERPROFILE%\.lingxi-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1. 删 HKCU Run 键（新版用这个自启）
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI >nul 2>&1
if not errorlevel 1 (
  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /f >nul 2>&1
  echo [OK] 已删除注册表自启 LingxiAI
)

REM 2. 删计划任务（旧版兼容）
schtasks /Query /TN "LingxiAI" >nul 2>&1
if not errorlevel 1 (
  schtasks /Delete /TN "LingxiAI" /F >nul 2>&1
  echo [OK] 已删除计划任务 LingxiAI
)

REM 3. 杀掉运行中的 node / wscript
echo [..] 停止后台服务进程...
taskkill /IM wscript.exe /F >nul 2>&1
REM 只杀 serve-permanent / proxy-server 相关 node，避免误杀其他 node 项目
for /f "tokens=2" %%P in ('wmic process where "name='node.exe' and commandline like '%%serve-permanent%%'" get processid /value 2^>nul ^| find "ProcessId="') do (
  taskkill /PID %%P /F >nul 2>&1
)
for /f "tokens=2" %%P in ('wmic process where "name='node.exe' and commandline like '%%proxy-server%%'" get processid /value 2^>nul ^| find "ProcessId="') do (
  taskkill /PID %%P /F >nul 2>&1
)
echo [OK] 后台进程已停止

REM 4. 删 publish.xml
if exist "%PUBLISH%" (
  del /F /Q "%PUBLISH%"
  echo [OK] 已删除 %PUBLISH%
)

REM 5. 删目标目录
if exist "%TARGET%" (
  rmdir /S /Q "%TARGET%"
  echo [OK] 已删除 %TARGET%
)

echo.
echo 卸载完成。重启 WPS 后插件不再加载。
echo.
echo 提示: 窗口保持打开。关闭请点右上角 X 按钮。
:_lingxi_hold_open_loop
pause >nul
goto _lingxi_hold_open_loop
