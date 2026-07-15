@echo off
REM One-click kill all WPS-related processes. Dev-only.
REM Double-click to run, or run from cmd: dev\kill-wps.bat
setlocal

echo [kill-wps] Scanning WPS processes...
echo.

REM Known WPS process image names (varies by version, hit them all, miss = silent)
set IMAGES=wps.exe wpsoffice.exe et.exe wpp.exe wpspdf.exe wpscloudsvr.exe wpscenter.exe wpsupdate.exe ksolaunch.exe ksomain.exe ksomisc.exe ksoFM.exe ksoUI.exe kdocs.exe kingsoftime.exe wtoolex.exe kxecoauth.exe ksolaunchremote.exe wpsnotify.exe wpsim.exe

for %%I in (%IMAGES%) do (
    tasklist /FI "IMAGENAME eq %%I" 2>nul | findstr /I "%%I" >nul
    if not errorlevel 1 (
        echo [kill-wps] kill: %%I
        taskkill /F /T /IM "%%I" >nul 2>&1
    )
)

echo.
echo [kill-wps] PowerShell sweep: prefix wps/kso/kdocs/kingsoft/wpp/et ...
powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.ProcessName -match '^(wps|kso|kdocs|kingsoft|wpp|et)' } | ForEach-Object { Write-Host ('[kill-wps] kill leftover: ' + $_.ProcessName + ' (' + $_.Id + ')'); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"

echo.
echo [kill-wps] Done.
echo.
pause
endlocal
