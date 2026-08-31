@echo off
chcp 65001 >nul 2>&1
REM Inno Setup 卸载前调本脚本: 停服务 + 删 publish.xml + 删 ~/.anthony-ai
setlocal

set "TARGET=%USERPROFILE%\.anthony-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1-2. 固定当前用户 SID，校验 Action/Run 数据后再删两个品牌的自启项。
set "TARGET_SID="
for /f "delims=" %%S in ('powershell -NoProfile -Command "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"') do set "TARGET_SID=%%S"
if "%TARGET_SID%"=="" exit /b 1
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0remove-product-autostart.ps1" -TargetSid "%TARGET_SID%" >nul 2>&1
if errorlevel 1 exit /b 1

REM 3. 停后台服务（只匹配已验证产品根目录）
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0stop-user-processes.ps1" -RootDir "%USERPROFILE%\.anthony-ai" >nul 2>&1
if errorlevel 1 exit /b 1
timeout /t 2 /nobreak >nul 2>&1

REM 4. publish.xml 是共享清单，只精确删除两品牌节点并保留第三方完整 XML 语义。
if not exist "%PUBLISH%" goto after_publish
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0update-wps-publish.ps1" -PublishPath "%PUBLISH%" -Mode Remove
if errorlevel 1 exit /b 1
:after_publish

REM 5. 删 ~/.anthony-ai 用户数据
if exist "%TARGET%" rmdir /S /Q "%TARGET%"
if exist "%TARGET%" (
  timeout /t 1 /nobreak >nul 2>&1
  rmdir /S /Q "%TARGET%"
)
if exist "%TARGET%" (
  timeout /t 1 /nobreak >nul 2>&1
  rmdir /S /Q "%TARGET%"
)

REM 6. 旧品牌用户数据目录（升级场景）
set "LEGACY_TARGET=%USERPROFILE%\.lingxi-ai"
if exist "%LEGACY_TARGET%" rmdir /S /Q "%LEGACY_TARGET%" >nul 2>&1

endlocal
exit /b 0
