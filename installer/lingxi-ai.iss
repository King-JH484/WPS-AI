; 灵犀AI Windows 安装器 - Inno Setup 5.5+
;
; 用 Inno Setup Compiler 编译:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\lingxi-ai.iss
; 或双击 installer\build.bat（自动找 ISCC.exe）。
;
; 编译前先确保 plugin\runtime\node-win-x64\node.exe 存在
;   cd plugin && node tools\bundle-node.js
;
; 产物：dist\lingxi-ai-1.2.0-beta-setup.exe

#define MyAppName "灵犀AI"
#define MyAppNameEn "Lingxi AI"
#define MyAppVersion "1.2.0-beta"
#define MyAppPublisher "lingxi-ai"
#define MyAppURL "https://github.com/lewis-hui1202/WPS-AI"

[Setup]
AppId={{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\LingxiAI
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=lingxi-ai-{#MyAppVersion}-setup
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#MyAppName} {#MyAppVersion}
ChangesAssociations=no
; SetupIconFile 留空,使用 Inno 默认图标(需 .ico,我们暂时只有 .svg)
DisableDirPage=auto

[Languages]
; ChineseSimplified.isl 是非官方翻译,Inno 6.7.1 默认没装,我们把它放在 installer/ 仓库里一并提交
Name: "chinese"; MessagesFile: "ChineseSimplified.isl"

[Files]
; 插件源码（包含 js / css / html / tools）。runtime/ 子目录跟着进去
Source: "..\plugin\*"; DestDir: "{app}\plugin"; Flags: ignoreversion recursesubdirs createallsubdirs
; 同步附带的 readme/license 便于卸载界面显示来源
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\卸载{#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; 装完后执行 post-install 脚本：建 ~/.lingxi-ai 变体、publish.xml、Run 键、起后台服务
Filename: "{app}\plugin\tools\post-install-windows.bat"; Parameters: """{app}"""; Flags: runhidden waituntilterminated; StatusMsg: "正在配置 WPS 加载项与后台服务..."
; 提示用户重启 WPS
Filename: "{app}\README.md"; Description: "查看安装后说明"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
; 卸载前先停服务 + 清理 publish.xml + ~/.lingxi-ai
Filename: "{app}\plugin\tools\pre-uninstall-windows.bat"; Flags: runhidden waituntilterminated; RunOnceId: "LingxiPreUninstall"

[Code]
function InitializeSetup(): Boolean;
begin
  // 安装前检查 runtime/node-win-x64/node.exe 是否在源目录存在（编译时打包进 .exe）
  // 这里我们用编译时检查代替——如果 ISCC 找不到 runtime/ 文件,编译就会报错,
  // 所以运行时不需要再做安全网。
  Result := True;
end;

procedure StopRunningServices();
var
  ResultCode: Integer;
  KillCmd: String;
begin
  // 升级场景:老版后台 node.exe(在 {app}\plugin\runtime\node-win-x64\)还跑着,
  // 锁住了 exe 文件,Inno 复制新文件会失败。先杀干净再让 Inno 接着干。
  // 卸载场景的 pre-uninstall-windows.bat 已经覆盖,这里只管安装/升级。
  // 注意:匹配条件不能含 "LingxiAI"(install dir 名),否则 PS 会把 Inno
  // 的 setup.exe 派生的 cmd.exe 链当成 lingxi 服务杀掉,post-install 没
  // 机会跑。只匹配实际跑 server 脚本的进程(CommandLine 含 serve-permanent.js
  // / proxy-server.js / .lingxi-ai 数据目录),再用 $PID/$ParentProcessId 兜底。
  KillCmd := '/c powershell -NoProfile -Command "$ErrorActionPreference=''SilentlyContinue''; $myPid=$PID; $myParent=(Get-CimInstance Win32_Process -Filter (''ProcessId='' + $PID)).ParentProcessId; Get-CimInstance Win32_Process | Where-Object { ($_.ProcessId -ne $myPid) -and ($_.ProcessId -ne $myParent) -and ($_.Name -in ''node.exe'',''wscript.exe'',''cmd.exe'') -and (($_.CommandLine -like ''*lingxi-ai*'') -or ($_.CommandLine -like ''*serve-permanent.js*'') -or ($_.CommandLine -like ''*proxy-server.js*'')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Seconds 2"';
  Exec(ExpandConstant('{cmd}'), KillCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PublishPath, LogPath: String;
begin
  // ssInstall 在文件复制之前触发,先杀掉老服务防文件锁
  if CurStep = ssInstall then begin
    StopRunningServices();
  end;

  // ssDone 在 [Run] 跑完之后触发,这时可以检查 post-install 有没有真的写出 publish.xml
  if CurStep = ssDone then begin
    PublishPath := ExpandConstant('{userappdata}\kingsoft\wps\jsaddons\publish.xml');
    LogPath := ExpandConstant('{%USERPROFILE}\.lingxi-ai\install.log');
    if not FileExists(PublishPath) then begin
      MsgBox(
        'post-install 没能写出 publish.xml,WPS 加载项不会显示「灵犀AI」。' + #13#10 + #13#10 +
        '日志在:' + #13#10 +
        LogPath + #13#10 + #13#10 +
        '常见原因:杀毒/PowerShell 策略拦了脚本,或 WPS 正在运行占住了目录。请把日志发给维护者。',
        mbError, MB_OK);
    end;
  end;
end;
