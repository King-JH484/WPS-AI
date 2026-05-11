@echo off
REM Inno Setup 卸载前调本脚本: 停服务 + 删 publish.xml + 删 ~/.lingxi-ai
setlocal

set "TARGET=%USERPROFILE%\.lingxi-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1. 删 Run 键
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI >nul 2>&1
if not errorlevel 1 reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /f >nul 2>&1

REM 2. 删旧版计划任务（兼容老安装）
schtasks /Query /TN "LingxiAI" >nul 2>&1
if not errorlevel 1 schtasks /Delete /TN "LingxiAI" /F >nul 2>&1

REM 3. 杀后台进程
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $myPid=$PID; $myParent=(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $myPid) -and ($_.ProcessId -ne $myParent) -and ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*serve-permanent.js*') -or ($_.CommandLine -like '*proxy-server.js*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 1 /nobreak >nul 2>&1

REM 4. 删 publish.xml
if exist "%PUBLISH%" del /F /Q "%PUBLISH%"

REM 5. 删 ~/.lingxi-ai 用户数据
if exist "%TARGET%" rmdir /S /Q "%TARGET%"

endlocal
exit /b 0
