; Anthony AI Windows 安装器 - Inno Setup 5.5+
;
; 用 Inno Setup Compiler 编译:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\anthony-ai.iss
; 或双击 installer\build.bat（自动找 ISCC.exe）。
;
; 编译前先确保 plugin\runtime\node-win-x64\node.exe 存在
;   cd plugin && node tools\bundle-node.js
;
; 产物：dist\anthony-ai-1.4.7-setup.exe

#define MyAppName "Anthony AI"
#define MyAppNameEn "Anthony AI"
#define MyAppVersion "1.4.7"
#define MyAppPublisher "anthony-ai"
#define MyAppURL "https://github.com/King-JH484/WPS-AI"
#ifndef SourceCommit
  #define SourceCommit "unknown"
#endif

[Setup]
AppId={{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\AnthonyAI
UsePreviousAppDir=no
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=anthony-ai-{#MyAppVersion}-setup
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayName={#MyAppName} {#MyAppVersion}
ChangesAssociations=no
; SetupIconFile 留空,使用 Inno 默认图标(需 .ico,我们暂时只有 .svg)
DisableDirPage=auto

[Languages]
; ChineseSimplified.isl 是非官方翻译,Inno 6.7.1 默认没装,我们把它放在 installer/ 仓库里一并提交
Name: "chinese"; MessagesFile: "ChineseSimplified.isl"

[Files]
; 插件源码（包含 js / css / html / tools）。排除开发依赖/产物；Windows 包只保留 node-win-x64 运行时。
Source: "..\plugin\*"; DestDir: "{app}\plugin"; Excludes: "node_modules\*,dist\*,dist-permanent\*,test\*,.git\*,*.log,wps-addon-build\*,wps-addon-publish\*,runtime\node-win-x64\node_modules\*,runtime\node-linux-*\*,runtime\node-darwin-*\*,runtime\*.zip,runtime\*.tar.gz,runtime\*.tar.xz,tools\anthony-launcher.exe"; Flags: ignoreversion recursesubdirs createallsubdirs
; 同步附带的 readme/license 便于卸载界面显示来源
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\INSTALL.md"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\卸载{#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; 提示用户重启 WPS
Filename: "{app}\README.md"; Description: "查看安装后说明"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallRun]
; 卸载前先停服务 + 清理 publish.xml + ~/.anthony-ai
Filename: "{app}\plugin\tools\pre-uninstall-windows.bat"; Flags: runhidden waituntilterminated; RunOnceId: "AnthonyPreUninstall"

[Code]
function LegacyInstallFound(RootKey: Integer): Boolean;
var
  DisplayName, InstallLocation: String;
begin
  DisplayName := '';
  InstallLocation := '';
  RegQueryStringValue(RootKey,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}_is1',
    'DisplayName', DisplayName);
  RegQueryStringValue(RootKey,
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}_is1',
    'InstallLocation', InstallLocation);
  Result := (Pos('灵犀', DisplayName) > 0) or
            (Pos('lingxi', Lowercase(DisplayName)) > 0) or
            (Pos('\lingxiai', Lowercase(InstallLocation)) > 0);
end;

function InitializeSetup(): Boolean;
begin
  // 同 AppId 的旧灵犀安装若仍登记，Inno 会共用卸载状态并留下旧目录。
  // 必须先由迁移脚本完整清理；安装器本身 fail-closed，不做静默覆盖。
  if LegacyInstallFound(HKCU) or LegacyInstallFound(HKLM32) or LegacyInstallFound(HKLM64) or
    DirExists(ExpandConstant('{%USERPROFILE}\.lingxi-ai')) or
    DirExists(ExpandConstant('{localappdata}\Programs\LingxiAI')) or
    DirExists(ExpandConstant('{commonpf}\LingxiAI')) or
    DirExists(ExpandConstant('{commonpf32}\LingxiAI')) then begin
    MsgBox('检测到品牌更换前的灵犀AI安装或 LingxiAI 目录。' + #13#10 +
      '请先按 Windows 干净迁移交接文档完成旧版卸载与残留复检，再安装 Anthony AI。',
      mbError, MB_OK);
    Result := False;
    exit;
  end;
  Result := True;
end;

procedure StopRunningServices();
var
  ResultCode: Integer;
  StopScript, KillCmd: String;
begin
  // Upgrade path: prefer the previous installed cleanup script. Avoid embedding
  // a long PowerShell process-killer command in the installer.
  StopScript := ExpandConstant('{app}\plugin\tools\stop-user-processes.ps1');
  if FileExists(StopScript) then begin
    ResultCode := -1;
    KillCmd := '-NoProfile -ExecutionPolicy RemoteSigned -File "' + StopScript + '" -RootDir "' + ExpandConstant('{%USERPROFILE}\.anthony-ai') + '" -TaskName "AnthonyAI"';
    if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), KillCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
      (ResultCode <> 0) then begin
      RaiseException('无法安全停止现有 Anthony AI 服务，退出码 ' + IntToStr(ResultCode));
    end;
    Sleep(2000);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  LogPath, MarkerPath, Params: String;
  ResultCode: Integer;
begin
  // ssInstall 在文件复制之前触发,先杀掉老服务防文件锁
  if CurStep = ssInstall then begin
    StopRunningServices();
  end;

  // 普通 [Run] 子进程的非零退出码不会自动让 Setup 失败；这里显式检查。
  if CurStep = ssPostInstall then begin
    ResultCode := -1;
    Params := '"' + ExpandConstant('{app}') + '" "{#SourceCommit}"';
    if (not Exec(ExpandConstant('{app}\plugin\tools\post-install-windows.bat'), Params,
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
      (ResultCode <> 0) then begin
      RaiseException('Anthony AI post-install 失败，退出码 ' + IntToStr(ResultCode) +
        '。日志：' + ExpandConstant('{%USERPROFILE}\.anthony-ai\install.log'));
    end;
  end;

  // 只有完整服务/路由探活通过，post-install 才会写完成标记。
  if CurStep = ssDone then begin
    MarkerPath := ExpandConstant('{%USERPROFILE}\.anthony-ai\install-complete.json');
    LogPath := ExpandConstant('{%USERPROFILE}\.anthony-ai\install.log');
    if not FileExists(MarkerPath) then begin
      MsgBox(
        'post-install 没能写出经过完整探活的成功标记，安装不能视为成功。' + #13#10 + #13#10 +
        '日志在:' + #13#10 +
        LogPath + #13#10 + #13#10 +
        '常见原因:杀毒/PowerShell 策略拦截、计划任务注册失败或服务/路由探活失败。',
        mbError, MB_OK);
    end;
  end;
end;
