@echo off
REM ??????????AI Windows ?????
REM ?锟斤拷???????????,????? cd installer && build.bat
REM ????
REM   1. ? Inno Setup Compiler  https://jrsoftware.org/isdl.php
REM   2. ???? cd plugin && node tools\bundle-node.js ?o? portable Node

setlocal
cd /d "%~dp0"

REM ?? ISCC.exe
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe"      set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
REM Fix W4: the .iss uses IS 6.3+ directives (x64compatible/autopf/WizardStyle=modern), IS5 cannot compile it.
REM Only fall back to IS5 when no IS6 is found (previously it unconditionally overrode a valid IS6).
if "%ISCC%"=="" if exist "%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe"

if "%ISCC%"=="" (
  echo [X] ???? Inno Setup Compiler ^(ISCC.exe^)??
  echo     ??? https://jrsoftware.org/isdl.php ???? Inno Setup 6 ?????
  pause
  exit /b 1
)

REM 锟斤拷?? runtime/ ?????
if not exist "..\plugin\runtime\node-win-x64\node.exe" (
  echo [X] plugin\runtime\node-win-x64\node.exe ???????
  echo     ?????? plugin ????: node tools\bundle-node.js
  pause
  exit /b 1
)

echo [build] ISCC: %ISCC%
echo [build] ???? installer\lingxi-ai.iss...
"%ISCC%" lingxi-ai.iss
if errorlevel 1 (
  echo [X] ???????
  pause
  exit /b 1
)

echo.
echo [build] ??锟斤拷??????? dist\lingxi-ai-*-setup.exe
pause
