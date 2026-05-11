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

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // 等 post-install 跑完。Inno 会在 [Run] 段自动跑,不用我们额外做事
  end;
end;
