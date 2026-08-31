param(
  [Parameter(Mandatory=$true)][string]$RootDir,
  [string]$TaskName = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RootDir)) {
  Write-Output "[stop-user-processes] 目录不存在，无需停止: $RootDir"
  exit 0
}

$root = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $RootDir).Path).TrimEnd('\')
if ($root.Length -lt 8 -or $root -eq [System.IO.Path]::GetPathRoot($root)) {
  throw "拒绝使用不安全的产品根目录: $root"
}

if ($TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $actionText = [string](($task.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments + ' ' + $_.WorkingDirectory }) -join ' ')
    if ($actionText.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } else {
      throw "计划任务 $TaskName 的 Action 不指向已验证目录，拒绝停止"
    }
  }
}

$selfPid = $PID
$parentPid = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)).ParentProcessId
$stopped = 0
Get-CimInstance Win32_Process | ForEach-Object {
  $proc = $_
  if ($proc.ProcessId -eq $selfPid -or $proc.ProcessId -eq $parentPid) { return }
  if ($proc.Name -notin @('node.exe','wscript.exe','cmd.exe','powershell.exe','lingxi-launcher.exe','anthony-launcher.exe')) { return }
  $haystack = ([string]$proc.ExecutablePath) + "`n" + ([string]$proc.CommandLine)
  if ($haystack.IndexOf($root, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
  $stopped += 1
}

Write-Output "STOPPED=$stopped"
