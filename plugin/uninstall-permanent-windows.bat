@echo off
title Anthony AI 永久卸载（Windows）

echo ============================================
echo   Anthony AI 永久卸载
echo ============================================
echo.

set "TARGET=%USERPROFILE%\.anthony-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1. 删 HKCU Run 键（新版用这个自启）
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v AnthonyAI >nul 2>&1
if not errorlevel 1 (
  reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v AnthonyAI /f >nul 2>&1
  echo [OK] 已删除注册表自启 AnthonyAI
)

REM 2. 删计划任务（旧版兼容）
schtasks /Query /TN "AnthonyAI" >nul 2>&1
if not errorlevel 1 (
  schtasks /Delete /TN "AnthonyAI" /F >nul 2>&1
  echo [OK] 已删除计划任务 AnthonyAI
)

REM 3. 杀掉运行中的 anthony 相关进程
echo [..] 停止后台服务进程...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $myPpid = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $myPpid -and ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*\.anthony-ai\*') -or ($_.ExecutablePath -like '*\.anthony-ai\*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1
echo [OK] 后台进程已停止

REM 4. 删 publish.xml
if exist "%PUBLISH%" (
  del /F /Q "%PUBLISH%"
  echo [OK] 已删除 %PUBLISH%
)

REM 5. 删目标目录
if exist "%TARGET%" (
  rmdir /S /Q "%TARGET%"
  if exist "%TARGET%" (
    echo [WARN] %TARGET% 部分文件无法删除（可能被其他进程占用）
    echo        建议重启 Windows 后再次运行此卸载脚本
  ) else (
    echo [OK] 已删除 %TARGET%
  )
)

echo.
echo 卸载完成。重启 WPS 后插件不再加载。

REM 统一出口：窗口保持打开，X 关闭
:_anthony_hold_open
echo.
echo 窗口保持打开。要关闭请点窗口右上角的 X。
:_anthony_hold_open_loop
timeout /t 3600 /nobreak >nul 2>&1
goto :_anthony_hold_open_loop
