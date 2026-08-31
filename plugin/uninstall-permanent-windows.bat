@echo off
chcp 65001 >nul 2>&1
title Anthony AI 永久卸载（Windows）

echo ============================================
echo   Anthony AI 永久卸载
echo ============================================
echo.

set "TARGET=%USERPROFILE%\.anthony-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1-2. 固定当前用户 SID，校验 Action/Run 数据后再删两个品牌的自启项。
set "TARGET_SID="
for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"') do set "TARGET_SID=%%S"
if "%TARGET_SID%"=="" goto :_anthony_hold_open
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\remove-product-autostart.ps1" -TargetSid "%TARGET_SID%" >nul 2>&1
if errorlevel 1 (
  echo [X] 自启项安全校验失败，已中止卸载
  goto :_anthony_hold_open
)
REM 3. 停止运行中的 Anthony AI 相关进程
echo [..] 停止后台服务进程...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\stop-user-processes.ps1" -RootDir "%USERPROFILE%\.anthony-ai" >nul 2>&1
if errorlevel 1 (
  echo [X] 停止后台进程失败，已中止卸载
  goto :_anthony_hold_open
)
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\stop-user-processes.ps1" -RootDir "%USERPROFILE%\.lingxi-ai" >nul 2>&1
if errorlevel 1 (
  echo [X] 停止旧品牌后台进程失败，已中止卸载
  goto :_anthony_hold_open
)
timeout /t 2 /nobreak >nul 2>&1
echo [OK] 后台进程已停止

REM 4. 只删除两品牌的 publish.xml 节点，保留第三方加载项。
if exist "%PUBLISH%" (
  powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\update-wps-publish.ps1" -PublishPath "%PUBLISH%" -Mode Remove
  if errorlevel 1 (
    echo [X] publish.xml 无法安全更新，已中止卸载
    goto :_anthony_hold_open
  )
  echo [OK] 已移除 Anthony AI / 灵犀AI 加载项条目
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
REM 6. 旧品牌残留目录（升级场景）
set "LEGACY_TARGET=%USERPROFILE%\.lingxi-ai"
if exist "%LEGACY_TARGET%" (
  rmdir /S /Q "%LEGACY_TARGET%" >nul 2>&1
  if not exist "%LEGACY_TARGET%" echo [OK] 已删除旧品牌残留 %LEGACY_TARGET%
)
if exist "%ProgramFiles%\LingxiAI" (
  echo [!] 检测到旧品牌安装目录 %ProgramFiles%\LingxiAI
  echo     它由旧版安装包创建，需管理员权限，请在「设置 - 应用」里卸载旧版，
  echo     或以管理员身份执行： rmdir /S /Q "%ProgramFiles%\LingxiAI"
)

echo 卸载完成。重启 WPS 后插件不再加载。

REM 统一出口：窗口保持打开，X 关闭
:_anthony_hold_open
echo.
echo 窗口保持打开。要关闭请点窗口右上角的 X。
:_anthony_hold_open_loop
timeout /t 3600 /nobreak >nul 2>&1
goto :_anthony_hold_open_loop
