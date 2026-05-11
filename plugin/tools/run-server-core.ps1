param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath
)

# 计划任务 logon trigger 启 powershell.exe 时,即使带 -WindowStyle Hidden 也
# 可能闪一下黑窗,或某些 Win10 build 上 Hidden 干脆不生效。
# 这里第一时间用 Win32 API 把当前 console 窗口隐藏掉,兜底所有 Hidden 失效场景。
$sig = '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
Add-Type -Name W -Namespace P -MemberDefinition $sig | Out-Null
[void][P.W]::ShowWindow([P.W]::GetConsoleWindow(), 0)

$env:LINGXI_STATIC_PORT = "$StaticPort"
$env:PROXY_PORT = "$ProxyPort"

# `& exe args *>> log` 把 stdout/stderr 6 个流追加到日志。
# node 是 console subsystem app,会继承父 PS 的 console — 而我们刚把它藏掉了
# → node 也看不见窗口。
& $NodeExe $ScriptPath '--root' $RootDir *>> $LogPath
