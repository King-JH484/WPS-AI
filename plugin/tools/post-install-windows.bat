@echo off
REM Inno Setup 装好文件后调本脚本做注册逻辑:
REM   1. 检测可用的 Node.exe（优先内置 runtime/node-win-x64/node.exe,退到系统 PATH）
REM   2. 生成 plugin-wps/-et/-wpp 三宿主变体到 %TARGET%
REM   3. 拷服务脚本
REM   4. 写 publish.xml 给 WPS 加载项注册
REM   5. 生成 vbs + wrapper bat
REM   6. 注册表 Run 键开机自启
REM   7. 启动后台服务
REM
REM 调用方式（由 Inno [Run] 段触发）:
REM   post-install-windows.bat <INSTALL_DIR>
REM 其中 INSTALL_DIR = Inno 安装目录（绝对路径,不带末尾反斜杠）

setlocal

REM ---- 解析参数 ----
if "%~1"=="" (
  set "INSTALL_DIR=%~dp0.."
) else (
  set "INSTALL_DIR=%~1"
)
REM 去掉末尾反斜杠
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "TARGET=%USERPROFILE%\.lingxi-ai"

REM ---- 1. 选择 Node ----
set "NODE_EXE=%INSTALL_DIR%\runtime\node-win-x64\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [X] 内置 Node 未找到 ^(%NODE_EXE%^),系统也没装 Node。
    exit /b 1
  )
  set "NODE_EXE=node"
)
echo [post-install] 使用 Node: %NODE_EXE%
"%NODE_EXE%" --version

REM ---- 2. 停旧服务（升级场景）----
echo [post-install] 停旧服务...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','wscript.exe','cmd.exe') -and (($_.CommandLine -like '*lingxi-ai*') -or ($_.ExecutablePath -like '*lingxi-ai*')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1

REM ---- 3. 生成三宿主变体 ----
echo [post-install] 生成三宿主变体到 %TARGET%...
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
copy /Y "%INSTALL_DIR%\plugin\tools\serve-permanent.js" "%TARGET%\tools\serve-permanent.js" >nul
copy /Y "%INSTALL_DIR%\plugin\tools\proxy-server.js"   "%TARGET%\tools\proxy-server.js"   >nul

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

REM ---- 6. 生成 vbs + wrapper bat（指向内置 Node）----
set "RUN_VBS=%TARGET%\run-server-hidden.vbs"
set "DEBUG_BAT=%TARGET%\run-server-debug.bat"
set "WRAPPER_BAT=%TARGET%\start-lingxi-server.bat"
(
  echo Set ws = CreateObject^("Wscript.Shell"^)
  echo ws.Run "cmd /c ""%NODE_EXE%"" ""%TARGET%\tools\serve-permanent.js"" --root ""%TARGET%"" >> ""%TARGET%\server.log"" 2>&1", 0, False
) > "%RUN_VBS%"
(
  echo @echo off
  echo title 灵犀AI 后台服务（调试模式）
  echo "%NODE_EXE%" "%TARGET%\tools\serve-permanent.js" --root "%TARGET%"
) > "%DEBUG_BAT%"
(
  echo @echo off
  echo start "" /B wscript.exe "%%~dp0run-server-hidden.vbs"
  echo exit
) > "%WRAPPER_BAT%"

REM ---- 7. 注册表 Run 键自启 ----
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /t REG_SZ /d "\"%WRAPPER_BAT%\"" /f >nul

REM ---- 8. 立即启动后台服务 ----
start "" /B wscript.exe "%RUN_VBS%"

echo [post-install] 完成。后台服务已在 :3889/:3890 监听。
endlocal
exit /b 0
