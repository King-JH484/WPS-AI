@echo off
REM 把控制台切到 UTF-8,这样 bat echo / node stdout / powershell output 三家
REM 输出都是 UTF-8 字节,install.log 单一编码,Notepad 查不再花屏
chcp 65001 >nul 2>&1

REM Inno Setup 装完文件后跑的脚本,注册逻辑:
REM   1. 挑能用的 Node.exe（优先用内置 plugin\runtime\node-win-x64\node.exe）
REM   2. 生成 plugin-wps/-et/-wpp 三份宿主变体到 %TARGET%
REM   3. 拷服务脚本
REM   4. 写 publish.xml 让 WPS 注册三个加载项
REM   5. 清理老安装的 vbs / wrapper bat / Run 键(被杀软误报删过)
REM   6. 用 PowerShell ScheduledTask cmdlet 注册一个 ONLOGON 计划任务,
REM      由 Task Scheduler 直接调 node.exe,不经任何 vbs/bat 包装,
REM      避开杀软对 .vbs 的误报
REM   7. 立即起服务 + 探活
REM
REM 调用方式（由 Inno [Run] 段触发）:
REM   post-install-windows.bat <INSTALL_DIR>
REM
REM 所有输出走日志,便于失败时排查:
REM   %USERPROFILE%\.lingxi-ai\install.log

setlocal

if "%~1"=="" (
  set "INSTALL_DIR=%~dp0.."
) else (
  set "INSTALL_DIR=%~1"
)
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "TARGET=%USERPROFILE%\.lingxi-ai"

if not exist "%TARGET%" mkdir "%TARGET%" >nul 2>&1
set "INSTALL_LOG=%TARGET%\install.log"

call :main >>"%INSTALL_LOG%" 2>&1
set "RC=%errorlevel%"
endlocal & exit /b %RC%

:main
echo.
echo ===================================================
echo  post-install 启动 %DATE% %TIME%
echo  INSTALL_DIR=%INSTALL_DIR%
echo  TARGET=%TARGET%
echo ===================================================

REM ---- 1. 挑 Node ----
set "NODE_EXE=%INSTALL_DIR%\plugin\runtime\node-win-x64\node.exe"
if not exist "%NODE_EXE%" (
  echo [WARN] 内置 Node 不在 %NODE_EXE%,退到系统 PATH
  where node >nul 2>&1
  if errorlevel 1 (
    echo [X] 内置 Node 没找到,系统也没装 Node。
    echo     请去 https://nodejs.org/zh-cn/ 装一份 LTS 再重装。
    exit /b 1
  )
  set "NODE_EXE=node"
)
echo [post-install] 使用 Node: %NODE_EXE%
"%NODE_EXE%" --version

REM ---- 2. 停老服务 ----
echo [post-install] 停老服务...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $myPid=$PID; $myParent=(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $myPid) -and ($_.ProcessId -ne $myParent) -and ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*lingxi-ai*') -or ($_.CommandLine -like '*serve-permanent.js*') -or ($_.CommandLine -like '*proxy-server.js*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul 2>&1

REM ---- 3. 生成三份宿主变体 ----
echo [post-install] 生成三份宿主变体到 %TARGET%...
pushd "%INSTALL_DIR%\plugin"
"%NODE_EXE%" tools\build-variants.js --out "%TARGET%"
if errorlevel 1 (
  echo [X] 生成宿主变体失败
  popd
  exit /b 1
)
popd

REM ---- 4. 拷服务脚本 ----
if not exist "%TARGET%\tools" mkdir "%TARGET%\tools"
copy /Y "%INSTALL_DIR%\plugin\tools\serve-permanent.js" "%TARGET%\tools\serve-permanent.js"
copy /Y "%INSTALL_DIR%\plugin\tools\proxy-server.js"   "%TARGET%\tools\proxy-server.js"

REM ---- 5a. 探活端口,3889/3890 被 Hyper-V/WSL2 排除时回退到 13889/13890 ----
for /f "tokens=1,2" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\plugin\tools\pick-ports.ps1"') do (
  set "STATIC_PORT=%%a"
  set "PROXY_PORT=%%b"
)
echo [post-install] 选中端口: STATIC=%STATIC_PORT% PROXY=%PROXY_PORT%

REM ---- 5b. 写 publish.xml (URL 用选中的 static 端口) ----
set "JSADDONS=%APPDATA%\kingsoft\wps\jsaddons"
if not exist "%JSADDONS%" mkdir "%JSADDONS%"
set "PUBLISH=%JSADDONS%\publish.xml"
(
  echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
  echo ^<jsplugins^>
  echo   ^<jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:%STATIC_PORT%/wps/" debug="" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:%STATIC_PORT%/et/"  debug="" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:%STATIC_PORT%/wpp/" debug="" enable="enable" install="null"/^>
  echo ^</jsplugins^>
) > "%PUBLISH%"
echo [post-install] publish.xml 已写: %PUBLISH%

REM ---- 5c. 如果 proxy 端口变了,把 TARGET 下 JS 里硬编码的 :3890 改成新端口 ----
if not %PROXY_PORT%==3890 (
  echo [post-install] 把客户端 JS 里的 :3890 改成 :%PROXY_PORT% ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\plugin\tools\rewrite-proxy-port.ps1" -TargetDir "%TARGET%" -ProxyPort %PROXY_PORT%
)

REM ---- 6. 清理老安装的 vbs / wrapper bat / Run 键 (被杀软误报删过) ----
echo [post-install] 清理老 vbs/Run 键残留...
if exist "%TARGET%\run-server-hidden.vbs"   del /F /Q "%TARGET%\run-server-hidden.vbs"
if exist "%TARGET%\start-lingxi-server.bat" del /F /Q "%TARGET%\start-lingxi-server.bat"
if exist "%TARGET%\run-server.bat"          del /F /Q "%TARGET%\run-server.bat"
if exist "%TARGET%\run-server.ps1"          del /F /Q "%TARGET%\run-server.ps1"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI >nul 2>&1
if not errorlevel 1 reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /f >nul 2>&1

REM ---- 7. run-server-core.ps1 跟着安装包装,不在用户目录生成任何 .ps1 ----
REM 不再生成 %TARGET%\run-server.ps1 (跟杀软 / quoting 都解耦)。
REM Task Action 直接调 powershell.exe + -File <run-server-core.ps1> + 一堆 -Xxx 参数。
set "CORE_PS1=%INSTALL_DIR%\plugin\tools\run-server-core.ps1"

REM ---- 8. 注册 ONLOGON 计划任务,Action 直接调 powershell + run-server-core.ps1 ----
REM 清掉老 server.log,这轮探活才能看到本次启动的错误
if exist "%TARGET%\server.log" del "%TARGET%\server.log" >nul 2>&1
echo [post-install] 注册 LingxiAI 计划任务...
REM register-task.ps1 接所有参数,内部拼 Action.Argument,bat 端只透传
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\plugin\tools\register-task.ps1" -CorePs1 "%CORE_PS1%" -NodeExe "%NODE_EXE%" -ScriptPath "%TARGET%\tools\serve-permanent.js" -RootDir "%TARGET%" -StaticPort %STATIC_PORT% -ProxyPort %PROXY_PORT% -LogPath "%TARGET%\server.log"
if errorlevel 1 (
  echo [X] 计划任务注册失败,服务不会开机自启
  exit /b 1
)

REM ---- 9. 生成调试用 bat(前台跑,方便看日志) ----
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
(
  echo @echo off
  echo title 灵犀AI 后台服务（调试模式）
  echo set "LINGXI_STATIC_PORT=%STATIC_PORT%"
  echo set "PROXY_PORT=%PROXY_PORT%"
  echo "%NODE_EXE%" "%TARGET%\tools\serve-permanent.js" --root "%TARGET%"
) > "%DEBUG_BAT%"

REM ---- 10. 探活:等 3 秒后查 3889 端口 ----
echo [post-install] 等服务起来...
timeout /t 3 /nobreak >nul 2>&1
powershell -NoProfile -Command "try { $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port %STATIC_PORT% -InformationLevel Quiet -WarningAction SilentlyContinue; if ($ok) { Write-Output ('[OK] %STATIC_PORT% 端口监听中,服务起来了') } else { Write-Output ('[WARN] %STATIC_PORT% 端口没监听 - 以下是 server.log 内容(node 启动错误):'); Write-Output '----------------------------------------'; if (Test-Path '%TARGET%\server.log') { Get-Content '%TARGET%\server.log' -Raw -ErrorAction SilentlyContinue } else { Write-Output '(server.log 不存在,task 可能根本没跑)' } ; Write-Output '----------------------------------------'; Write-Output '同时检查计划任务的 Last Run Result:'; Get-ScheduledTask LingxiAI | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns | Format-List | Out-String } } catch { Write-Output ('[WARN] 探活失败: ' + $_.Exception.Message) }"

REM ---- 11. WPS 加载项路由探活:看 plugin 三件套的 manifest/ribbon 能不能拿到 ----
REM 如果 WPS 显示"打开 JS 编辑器"而不是按钮,通常是这里有 404
echo [post-install] WPS 加载项路由探活...
powershell -NoProfile -Command "foreach ($host in @('wps','et','wpp')) { foreach ($file in @('manifest.json','ribbon.xml','index.html')) { $url = 'http://127.0.0.1:%STATIC_PORT%/' + $host + '/' + $file; try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3; Write-Output ('[OK] ' + $url + ' -> HTTP ' + $r.StatusCode + ', ' + $r.Content.Length + ' bytes') } catch { Write-Output ('[X]  ' + $url + ' -> ' + $_.Exception.Message) } } }"

echo [post-install] 完成
exit /b 0
