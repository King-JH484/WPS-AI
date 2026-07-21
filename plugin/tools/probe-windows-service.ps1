param(
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][string]$LogPath
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-LocalPort([int]$Port) {
  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(1000, $false)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

try {
  $ok = Test-LocalPort -Port $StaticPort
  if ($ok) {
    Write-Output "[OK] $StaticPort port is listening"
    exit 0
  }

  Write-Output "[WARN] $StaticPort port is not listening. server.log:"
  Write-Output '----------------------------------------'
  if (Test-Path -LiteralPath $LogPath) {
    Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
  } else {
    Write-Output '(server.log does not exist)'
  }
  Write-Output '----------------------------------------'
  Write-Output 'Scheduled task status:'
  Get-ScheduledTask LingxiAI |
    Get-ScheduledTaskInfo |
    Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns |
    Format-List |
    Out-String
} catch {
  Write-Output ('[WARN] probe failed: ' + $_.Exception.Message)
}
