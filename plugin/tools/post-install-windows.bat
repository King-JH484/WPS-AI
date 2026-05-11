@echo off
REM Inno Setup 装完文件后跑的脚本，注册逻辑:
REM   1. 挑能用的 Node.exe（优先用内置 plugin\runtime\node-win-x64\node.exe，退到系统 PATH）
REM   2. 生成 plugin-wps/-et/-wpp 三份宿主变体到 %TARGET%
REM   3. 拷服务脚本
REM   4. 写 publish.xml 让 WPS 加载项注册
REM   5. 生成 run-server.bat + 隐藏窗口 vbs + wrapper bat
REM   6. 注册到 Run 键开机自启
REM   7. 起后台服务 + 探活
REM
REM 调用方式（由 Inno [Run] 段触发）:
REM   post-install-windows.bat <INSTALL_DIR>
REM 其中 INSTALL_DIR = Inno 安装目录的绝对路径，不带末尾反斜杠
REM
REM 所有输出走日志，便于失败时排查:
REM   %USERPROFILE%\.lingxi-ai\install.log

setlocal

REM ---- 解析入参 ----
if "%~1"=="" (
  set "INSTALL_DIR=%~dp0.."
) else (
  set "INSTALL_DIR=%~1"
)
REM 去掉末尾反斜杠
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "TARGET=%USERPROFILE%\.lingxi-ai"

REM 把日志目录建出来再 call :main 走重定向
if not exist "%TARGET%" mkdir "%TARGET%" >nul 2>&1
set "INSTALL_LOG=%TARGET%\install.log"

REM 整个主体重定向到日志文件，方便用户在 setup.exe 跑完后查
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
  echo [WARN] 内置 Node 不在 %NODE_EXE%，退到系统 PATH
  where node >nul 2>&1
  if errorlevel 1 (
    echo [X] 内置 Node 没找到，系统也没装 Node。
    echo     请去 https://nodejs.org/zh-cn/ 装一份 LTS 再重装，
    echo     或检查 setup.exe 是不是把 plugin\runtime\ 装到 %INSTALL_DIR%\plugin\ 下了。
    exit /b 1
  )
  set "NODE_EXE=node"
)
echo [post-install] 使用 Node: %NODE_EXE%
"%NODE_EXE%" --version

REM ---- 2. 停老服务（如果有跑着的）----
echo [post-install] 停老服务...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*lingxi-ai*') -or ($_.CommandLine -like '*LingxiAI*') -or ($_.ExecutablePath -like '*LingxiAI*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
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

REM ---- 5. 写 publish.xml ----
set "JSADDONS=%APPDATA%\kingsoft\wps\jsaddons"
if not exist "%JSADDONS%" mkdir "%JSADDONS%"
set "PUBLISH=%JSADDONS%\publish.xml"
(
  echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
  echo ^<jsplugins^>
  echo   ^<jspluginonline name="lingxi-ai-wps" type="wps" url="http://127.0.0.1:3889/wps/" debug="" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-et"  type="et"  url="http://127.0.0.1:3889/et/"  debug="" enable="enable" install="null"/^>
  echo   ^<jspluginonline name="lingxi-ai-wpp" type="wpp" url="http://127.0.0.1:3889/wpp/" debug="" enable="enable" install="null"/^>
  echo ^</jsplugins^>
) > "%PUBLISH%"
echo [post-install] publish.xml 已写: %PUBLISH%

REM ---- 6. 生成启动脚本 ----
REM 关键:把"node + 参数 + 重定向"放到 run-server.bat 里,vbs 只负责"隐藏窗口拉这个 bat",
REM 避免 cmd /c "<带空格路径>" 的引号剥离 bug(以前 Program Files 路径就是死在这)。
set "SERVICE_BAT=%TARGET%\run-server.bat"
set "RUN_VBS=%TARGET%\run-server-hidden.vbs"
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
set "WRAPPER_BAT=%TARGET%\start-lingxi-server.bat"

REM 6a. 实际启服务的 bat,bat 自己处理引号天然无歧义
REM    (...) 块里的 >> 和 2>&1 必须 ^ 转义,不然会被当成外层 echo 自己的重定向
(
  echo @echo off
  echo "%NODE_EXE%" "%TARGET%\tools\serve-permanent.js" --root "%TARGET%" ^>^> "%TARGET%\server.log" 2^>^&1
) > "%SERVICE_BAT%"

REM 6b. 隐藏窗口拉 service bat
(
  echo Set ws = CreateObject^("Wscript.Shell"^)
  echo ws.Run """%SERVICE_BAT%""", 0, False
) > "%RUN_VBS%"

REM 6c. 调试版(前台跑 node,看实时输出)
(
  echo @echo off
  echo title 灵犀AI 后台服务（调试模式）
  echo "%NODE_EXE%" "%TARGET%\tools\serve-permanent.js" --root "%TARGET%"
) > "%DEBUG_BAT%"

REM 6d. Run 键调的 wrapper(让 Run 键的路径里没空格)
(
  echo @echo off
  echo start "" /B wscript.exe "%%~dp0run-server-hidden.vbs"
  echo exit
) > "%WRAPPER_BAT%"

REM ---- 7. 注册到 Run 开机自启 ----
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /t REG_SZ /d "\"%WRAPPER_BAT%\"" /f
if errorlevel 1 echo [WARN] HKCU Run 写入失败

REM ---- 8. 立即起后台服务 ----
echo [post-install] 启动后台服务...
start "" /B wscript.exe "%RUN_VBS%"

REM ---- 9. 探活:等 3 秒后查 3889 端口 ----
echo [post-install] 等服务起来...
timeout /t 3 /nobreak >nul 2>&1
powershell -NoProfile -Command "try { $r = Test-NetConnection -ComputerName 127.0.0.1 -Port 3889 -InformationLevel Quiet -WarningAction SilentlyContinue; if ($r) { Write-Output '[OK] 3889 端口监听中,服务起来了' } else { Write-Output '[WARN] 3889 端口没监听,可能服务起失败,看 %TARGET%\server.log' } } catch { Write-Output ('[WARN] 探活失败: ' + $_.Exception.Message) }"

echo [post-install] 完成
exit /b 0
