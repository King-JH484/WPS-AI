param(
  [Parameter(Mandatory=$true)][string]$TargetSid
)

$ErrorActionPreference = 'Stop'
$productPattern = '(?i)(\.lingxi-ai|\.anthony-ai|\\LingxiAI(?:\\|$)|\\AnthonyAI(?:\\|$))'

foreach ($name in @('LingxiAI','AnthonyAI')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    $actionText = [string](($task.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments + ' ' + $_.WorkingDirectory }) -join ' ')
    if ($actionText -notmatch $productPattern) {
      throw "同名计划任务 $name 不指向产品目录，拒绝删除"
    }
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
  }
}

$runPath = "Registry::HKEY_USERS\$TargetSid\Software\Microsoft\Windows\CurrentVersion\Run"
if (Test-Path $runPath) {
  $props = Get-ItemProperty $runPath
  foreach ($name in @('LingxiAI','AnthonyAI')) {
    $value = [string]$props.$name
    if (-not $value) { continue }
    if ($value -notmatch $productPattern) {
      throw "同名 Run 值 $name 不指向产品目录，拒绝删除"
    }
    Remove-ItemProperty -Path $runPath -Name $name -Force
  }
}

Write-Output '[OK] 产品计划任务与 Run 值已安全移除'
