param(
  [Parameter(Mandatory=$true)][string]$LauncherExe,
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [string]$TaskUserId = '',
  [string]$TaskName = 'LingxiAI'
)

# 注册一个 ONLOGON 计划任务: 启 lingxi-launcher.exe (winexe GUI 子系统,无 console),
# 由它 spawn node 跑后台服务。task 期间无任何可见窗口。

$ErrorActionPreference = 'Stop'

foreach ($p in @($LauncherExe, $NodeExe, $ScriptPath)) {
  if (-not (Test-Path $p)) { throw "文件不存在: $p" }
}

# 默认用 WindowsIdentity；安装脚本可显式传入真正打开 WPS 的交互用户。
$wid = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userId = if ($TaskUserId) { $TaskUserId } else { $wid.Name }      # 形如 DESKTOP-XYZ\W 或 DOMAIN\W
try {
  $userSid = ([System.Security.Principal.NTAccount]$userId).
    Translate([System.Security.Principal.SecurityIdentifier]).Value
} catch {
  $userSid = $wid.User.Value
}
Write-Output "[register-task] 目标用户 = $userId  (SID=$userSid)"
Write-Output "[register-task] 当前进程用户 = $($wid.Name)  (SID=$($wid.User.Value))"
Write-Output "[register-task] env USERNAME = $env:USERNAME, USERDOMAIN = $env:USERDOMAIN"

# 拼 launcher 的命令行参数:
#   <logPath> <staticPort> <proxyPort> <nodeExe> <scriptPath> --root <rootDir>
$launcherArg = (
  "`"$LogPath`" " +
  "$StaticPort " +
  "$ProxyPort " +
  "`"$NodeExe`" " +
  "`"$ScriptPath`" " +
  "--root `"$RootDir`""
)

$action = New-ScheduledTaskAction `
  -Execute $LauncherExe `
  -Argument $launcherArg `
  -WorkingDirectory $RootDir

# 用 DOMAIN\USER 形式,Task Scheduler 老版本更兼容
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId

# 精简 Settings;不设 ExecutionTimeLimit(默认 unlimited),不要 Hidden 用 -Hidden flag
# (Hidden 是 Task UI 隐藏,跟 launcher 隐藏窗口无关)
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable
$settings.Hidden = $true
$settings.ExecutionTimeLimit = 'PT0S'  # 0=无时限

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Description 用纯 ASCII,避开某些 Task Scheduler 版本对 fullwidth 字符的怪解析
try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Lingxi AI background service (ports 3889 / 3890)' `
    -Force | Out-Null
} catch {
  Write-Output "[X] Register-ScheduledTask 失败"
  Write-Output ("    Message:    " + $_.Exception.Message)
  Write-Output ("    HResult:    0x{0:X}" -f $_.Exception.HResult)
  Write-Output ("    UserId:     " + $userId)
  Write-Output ("    LauncherExe:" + $LauncherExe)
  Write-Output ("    RootDir:    " + $RootDir)
  Write-Output ("    Argument:   " + $launcherArg)
  throw
}

Start-ScheduledTask -TaskName $TaskName

Write-Output "[OK] 计划任务 '$TaskName' 已注册并启动"
Write-Output "  Execute:    $LauncherExe"
Write-Output "  Arguments:  $launcherArg"
Write-Output "  WorkingDir: $RootDir"
Write-Output "  UserId:     $userId"
