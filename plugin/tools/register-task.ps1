param(
  [Parameter(Mandatory=$true)][string]$CorePs1,
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [string]$TaskName = 'LingxiAI'
)

# 注册一个 ONLOGON 计划任务: 启 powershell.exe → run-server-core.ps1 → 起 node。
# Action.Argument 在这里完整拼好,杜绝从 bat 传字符串过来的 quoting 灾难。

$ErrorActionPreference = 'Stop'

foreach ($p in @($CorePs1, $NodeExe, $ScriptPath)) {
  if (-not (Test-Path $p)) { throw "文件不存在: $p" }
}

# 拼 powershell.exe 的 -File 参数。所有带空格的路径都用反引号转义的双引号包。
$psArg = (
  '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden ' +
  "-File `"$CorePs1`" " +
  "-NodeExe `"$NodeExe`" " +
  "-ScriptPath `"$ScriptPath`" " +
  "-RootDir `"$RootDir`" " +
  "-StaticPort $StaticPort " +
  "-ProxyPort $ProxyPort " +
  "-LogPath `"$LogPath`""
)

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument $psArg `
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
Write-Output "  Execute:   powershell.exe"
Write-Output "  Arguments: $psArg"
Write-Output "  WorkingDir: $RootDir"
