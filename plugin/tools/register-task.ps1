param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$TargetDir,
  [string]$TaskName = 'LingxiAI'
)

$ErrorActionPreference = 'Stop'

$servePath = Join-Path $TargetDir 'tools\serve-permanent.js'
$logPath = Join-Path $TargetDir 'server.log'

if (-not (Test-Path $NodeExe)) { throw "Node 不存在: $NodeExe" }
if (-not (Test-Path $servePath)) { throw "serve-permanent.js 不存在: $servePath" }

# Action: 直接跑 node.exe,参数里走 \" 转义路径里的空格
$argString = "`"$servePath`" --root `"$TargetDir`""
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument $argString -WorkingDirectory $TargetDir

# Trigger: 当前用户登录时跑
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: 隐藏窗口 / 单实例 / 不限时长 / 电池上也跑
$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

# Principal: 用当前交互式用户身份跑,不要管理员
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# 如果老任务在,Unregister 一下,避免 Register-ScheduledTask 撞参数差异报错
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

# 立即启动一次,不用等下次登录
Start-ScheduledTask -TaskName $TaskName

Write-Output "[OK] 计划任务 '$TaskName' 已注册并启动"
Write-Output "  Node:   $NodeExe"
Write-Output "  Script: $servePath"
Write-Output "  Root:   $TargetDir"
