param(
  [Parameter(Mandatory=$true)][string]$LauncherExe,
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [string]$TaskName = 'LingxiAI'
)

# 注册一个 ONLOGON 计划任务: 启 lingxi-launcher.exe (winexe GUI 子系统,无 console),
# 由它 spawn node 跑后台服务。task 期间无任何可见窗口。
#
# Action.Argument 在这里完整拼好,杜绝从 bat 串字符串过来的 quoting 灾难。

$ErrorActionPreference = 'Stop'

foreach ($p in @($LauncherExe, $NodeExe, $ScriptPath)) {
  if (-not (Test-Path $p)) { throw "文件不存在: $p" }
}

# 拼 launcher 的命令行参数。launcher 接的顺序是:
#   <logPath> <staticPort> <proxyPort> <nodeExe> <scriptPath> --root <rootDir>
# 带空格的路径用反引号转义包双引号
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

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description '灵犀AI 后台服务（端口 3889 / 3890）' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Output "[OK] 计划任务 '$TaskName' 已注册并启动"
Write-Output "  Execute:    $LauncherExe"
Write-Output "  Arguments:  $launcherArg"
Write-Output "  WorkingDir: $RootDir"
