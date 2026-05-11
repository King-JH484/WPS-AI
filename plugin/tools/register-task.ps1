param(
  [Parameter(Mandatory=$true)][string]$ExecPath,
  [string]$WorkingDir = '',
  [string]$TaskName = 'LingxiAI'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExecPath)) { throw "ExecPath 不存在: $ExecPath" }

$actionArgs = @{ Execute = $ExecPath }
if ($WorkingDir) { $actionArgs.WorkingDirectory = $WorkingDir }
$action = New-ScheduledTaskAction @actionArgs

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
Write-Output "  Execute:    $ExecPath"
Write-Output "  WorkingDir: $WorkingDir"
