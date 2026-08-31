@echo off
REM 把控制台切到 UTF-8,这样 bat echo / node stdout / powershell output 三家
REM 输出都是 UTF-8 字节,install.log 单一编码,Notepad 查不再花屏
chcp 65001 >nul 2>&1

REM Inno Setup 装完文件后跑的脚本,注册逻辑:
REM   1. 挑能用的 Node.exe（优先用内置 plugin\runtime\node-win-x64\node.exe）
REM   2. 生成 plugin-wps/-et/-wpp/-pdf 四份宿主变体到 %TARGET%
REM   3. 拷服务脚本
REM   4. 写 publish.xml 让 WPS 注册四个加载项
REM   5. 清理老安装的 vbs / wrapper bat / Run 键(被杀软误报删过)
REM   6. 用 PowerShell ScheduledTask cmdlet 注册一个 ONLOGON 计划任务,
REM      由 Task Scheduler 直接调 node.exe,不经任何 vbs/bat 包装,
REM      避开杀软对 .vbs 的误报
REM   7. 立即起服务 + 探活
REM
REM 调用方式（由 Inno [Run] 段触发）:
REM   post-install-windows.bat <INSTALL_DIR> <SOURCE_COMMIT>
REM
REM 所有输出走日志,便于失败时排查:
REM   %USERPROFILE%\.anthony-ai\install.log

setlocal

if "%~1"=="" (
  set "INSTALL_DIR=%~dp0.."
) else (
  set "INSTALL_DIR=%~1"
)
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "SOURCE_COMMIT=%~2"
if "%SOURCE_COMMIT%"=="" set "SOURCE_COMMIT=unknown"
for /f "tokens=1,* delims==" %%A in ('powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\resolve-windows-install-user.ps1"') do (
  if /I "%%A"=="TARGET_USER" set "TARGET_USER=%%B"
  if /I "%%A"=="TARGET_SID" set "TARGET_SID=%%B"
  if /I "%%A"=="TARGET_PROFILE" set "TARGET_PROFILE=%%B"
  if /I "%%A"=="TARGET_APPDATA" set "TARGET_APPDATA=%%B"
  if /I "%%A"=="TARGET_SOURCE" set "TARGET_SOURCE=%%B"
)
if "%TARGET_PROFILE%"=="" set "TARGET_PROFILE=%USERPROFILE%"
if "%TARGET_APPDATA%"=="" set "TARGET_APPDATA=%APPDATA%"
if "%TARGET_USER%"=="" set "TARGET_USER=%USERDOMAIN%\%USERNAME%"
if "%TARGET_SID%"=="" (
  echo [X] 无法解析目标 WPS 用户 SID，拒绝继续安装
  exit /b 1
)
set "TARGET=%TARGET_PROFILE%\.anthony-ai"

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
echo  TARGET_USER=%TARGET_USER%
echo  TARGET_SID=%TARGET_SID%
echo  TARGET_APPDATA=%TARGET_APPDATA%
echo  TARGET_SOURCE=%TARGET_SOURCE%
echo  SOURCE_COMMIT=%SOURCE_COMMIT%
echo  PROCESS_USER=%USERDOMAIN%\%USERNAME%
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
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\stop-user-processes.ps1" -RootDir "%TARGET%" -TaskName "AnthonyAI"
if errorlevel 1 (
  echo [X] 停止 Anthony AI 旧服务失败
  exit /b 1
)
timeout /t 2 /nobreak >nul 2>&1

REM ---- 2a. 停旧品牌（灵犀AI）自启项 ----
REM 旧版用 Run 键 / 计划任务自启，只杀进程下次登录还会回来抢 3889/3890。
REM 这些字面量是历史事实，不参与品牌改名替换，见 docs/REBRAND.md。
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\stop-user-processes.ps1" -RootDir "%TARGET_PROFILE%\.lingxi-ai" -TaskName "LingxiAI"
if errorlevel 1 (
  echo [X] 停止灵犀AI旧服务失败
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\remove-product-autostart.ps1" -TargetSid "%TARGET_SID%"
if errorlevel 1 (
  echo [X] 安全移除旧/当前产品自启项失败
  exit /b 1
)
timeout /t 1 /nobreak >nul 2>&1

REM ---- 2b. 清理覆盖安装遗留的开发依赖/构建产物 ----
echo [post-install] 清理旧安装目录冗余文件...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\cleanup-install-dir.ps1" -PluginDir "%INSTALL_DIR%\plugin"
if errorlevel 1 (
  echo [X] 清理安装目录失败
  exit /b 1
)

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
copy /Y "%INSTALL_DIR%\plugin\tools\serve-permanent.js" "%TARGET%\tools\serve-permanent.js" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\service-runner.js"   "%TARGET%\tools\service-runner.js" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\service-watchdog.ps1" "%TARGET%\tools\service-watchdog.ps1" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\run-hidden.vbs" "%TARGET%\tools\run-hidden.vbs" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\proxy-server.js"   "%TARGET%\tools\proxy-server.js" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\mcp-server.js"     "%TARGET%\tools\mcp-server.js" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\zip-extract.js"    "%TARGET%\tools\zip-extract.js" || exit /b 1
copy /Y "%INSTALL_DIR%\plugin\tools\pick-node.js"      "%TARGET%\tools\pick-node.js" || exit /b 1
if exist "%INSTALL_DIR%\plugin\runtime\node-win-x64\node.exe" (
  copy /Y "%INSTALL_DIR%\plugin\runtime\node-win-x64\node.exe" "%TARGET%\tools\node.exe"
  set "SERVICE_NODE_EXE=%TARGET%\tools\node.exe"
) else (
  set "SERVICE_NODE_EXE=%NODE_EXE%"
)

REM ---- 5a. 探活端口,3889/3890 被 Hyper-V/WSL2 排除时回退到 13889/13890 ----
set "STATIC_PORT="
set "PROXY_PORT="
for /f "tokens=1,2" %%a in ('powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\pick-ports.ps1"') do (
  set "STATIC_PORT=%%a"
  set "PROXY_PORT=%%b"
)
REM 修 W5：pick-ports.ps1 万一没输出，端口会是空，后面 `if not %PROXY_PORT%==3890` 会变成
REM 语法错误、publish.xml 里也会写出空端口的坏 URL。这里兜底回默认端口。
if "%STATIC_PORT%"=="" set "STATIC_PORT=3889"
if "%PROXY_PORT%"=="" set "PROXY_PORT=3890"
echo [post-install] 选中端口: STATIC=%STATIC_PORT% PROXY=%PROXY_PORT%

REM ---- 5b. 写 publish.xml (URL 用选中的 static 端口) ----
set "JSADDONS=%TARGET_APPDATA%\kingsoft\wps\jsaddons"
if not exist "%JSADDONS%" mkdir "%JSADDONS%"
set "PUBLISH=%JSADDONS%\publish.xml"
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\update-wps-publish.ps1" -PublishPath "%PUBLISH%" -Mode Install -StaticPort %STATIC_PORT%
if errorlevel 1 (
  echo [X] publish.xml 合并失败
  exit /b 1
)
echo [post-install] publish.xml 已写: %PUBLISH%
<nul set /p "=%PUBLISH%" > "%INSTALL_DIR%\anthony-install-target.txt"

REM ---- 5c. 如果 proxy 端口变了,把 TARGET 下 JS 里硬编码的 :3890 改成新端口 ----
if not "%PROXY_PORT%"=="3890" (
  echo [post-install] 把客户端 JS 里的 :3890 改成 :%PROXY_PORT% ...
  powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\rewrite-proxy-port.ps1" -TargetDir "%TARGET%" -ProxyPort %PROXY_PORT%
)

REM ---- 6. 清理老安装的 vbs / wrapper bat / Run 键 (被杀软误报删过) ----
echo [post-install] 清理老 vbs/Run 键残留...
if exist "%TARGET%\run-server-hidden.vbs"   del /F /Q "%TARGET%\run-server-hidden.vbs"
if exist "%TARGET%\start-anthony-server.bat" del /F /Q "%TARGET%\start-anthony-server.bat"
if exist "%TARGET%\run-server.bat"          del /F /Q "%TARGET%\run-server.bat"
if exist "%TARGET%\run-server.ps1"          del /F /Q "%TARGET%\run-server.ps1"
if exist "%TARGET%\tools\lingxi-launcher.exe" del /F /Q "%TARGET%\tools\lingxi-launcher.exe"
if exist "%TARGET%\tools\anthony-launcher.exe" del /F /Q "%TARGET%\tools\anthony-launcher.exe"

REM ---- 7. 注册 ONLOGON 计划任务,Action 调 Windows 自带 wscript 隐藏启动 watchdog ----
REM 清掉老 server.log,这轮探活才能看到本次启动的错误
if exist "%TARGET%\server.log" del "%TARGET%\server.log" >nul 2>&1
echo [post-install] 注册 AnthonyAI 计划任务...
REM register-task.ps1 接所有参数,内部拼 Action.Argument,bat 端只透传
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\register-task.ps1" -NodeExe "%SERVICE_NODE_EXE%" -ScriptPath "%TARGET%\tools\serve-permanent.js" -RunnerPath "%TARGET%\tools\service-runner.js" -WatchdogPath "%TARGET%\tools\service-watchdog.ps1" -HiddenRunnerPath "%TARGET%\tools\run-hidden.vbs" -RootDir "%TARGET%" -StaticPort %STATIC_PORT% -ProxyPort %PROXY_PORT% -LogPath "%TARGET%\server.log" -TaskUserId "%TARGET_USER%"
if errorlevel 1 (
  echo [X] 计划任务注册失败,服务不会开机自启
  exit /b 1
)

REM ---- 9. 生成调试用 bat(前台跑,方便看日志) ----
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
(
  echo @echo off
  echo title AnthonyAI background service debug
  echo set "ANTHONY_STATIC_PORT=%STATIC_PORT%"
  echo set "PROXY_PORT=%PROXY_PORT%"
  echo "%SERVICE_NODE_EXE%" "%TARGET%\tools\serve-permanent.js" --root "%TARGET%" --static-port %STATIC_PORT% --proxy-port %PROXY_PORT%
) > "%DEBUG_BAT%"

REM ---- 10. 探活:轮询等端口 up(计划任务->wscript->powershell->node 冷启动链最长要 ~9s，
REM      原来死等 3 秒后一次性探活会误报失败。probe 脚本内部轮询到 30s，端口 up 立即返回) ----
echo [post-install] 等服务起来...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\probe-windows-service.ps1" -StaticPort %STATIC_PORT% -ProxyPort %PROXY_PORT% -LogPath "%TARGET%\server.log" -TimeoutSeconds 30
if errorlevel 1 (
  echo [X] 后台服务探活失败
  exit /b 1
)

REM ---- 11. WPS 加载项路由探活:看 plugin 三件套的 manifest/ribbon 能不能拿到 ----
REM 如果 WPS 显示"打开 JS 编辑器"而不是按钮,通常是这里有 404
echo [post-install] WPS 加载项路由探活...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\probe-windows-routes.ps1" -StaticPort %STATIC_PORT%
if errorlevel 1 (
  echo [X] WPS 加载项路由探活失败
  exit /b 1
)

REM ---- 12. 只有全部步骤成功才写完成标记 ----
set "COMPLETE_MARKER=%TARGET%\install-complete.json"
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%INSTALL_DIR%\plugin\tools\write-install-marker.ps1" -Path "%COMPLETE_MARKER%" -TargetSid "%TARGET_SID%" -TargetUser "%TARGET_USER%" -SourceCommit "%SOURCE_COMMIT%" -InstallDir "%INSTALL_DIR%" -Runtime "%SERVICE_NODE_EXE%" -StaticPort %STATIC_PORT% -ProxyPort %PROXY_PORT%
if errorlevel 1 (
  echo [X] 安装完成标记写入失败
  exit /b 1
)

echo [post-install] 完成
exit /b 0
