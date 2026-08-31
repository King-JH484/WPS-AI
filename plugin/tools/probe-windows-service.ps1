param(
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  # 服务经 计划任务 -> wscript -> powershell -> node 冷启动这条长链，端口 listen 常要 4~9s。
  # 单次探活（原来 timeout 3s + 一次 probe）会在健康安装上误报失败，改成轮询等待。
  [int]$TimeoutSeconds = 30,
  [int]$PollSeconds = 1
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
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $ok = $false
  $waited = 0
  do {
    $ok = Test-LocalPort -Port $StaticPort
    if ($ok) { break }
    Start-Sleep -Seconds $PollSeconds
    $waited += $PollSeconds
  } while ((Get-Date) -lt $deadline)

  if ($ok) {
    $proxyOk = Test-LocalPort -Port $ProxyPort
    if ($proxyOk) {
      try {
        $health = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $StaticPort + "/health") -UseBasicParsing -TimeoutSec 3
        $proxyHealth = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $ProxyPort + "/healthz") -UseBasicParsing -TimeoutSec 3
        if ($health.StatusCode -eq 200 -and $proxyHealth.StatusCode -eq 200) {
          Write-Output "[OK] static=$StaticPort proxy=$ProxyPort 均已监听并通过 HTTP 探活 (waited ${waited}s)"
          exit 0
        }
      } catch {
        Write-Output ('[X] HTTP 探活失败: ' + $_.Exception.Message)
      }
    } else {
      Write-Output "[X] proxy 端口 $ProxyPort 未监听"
    }
  }
  Write-Output "[WARN] waited ${TimeoutSeconds}s, $StaticPort port still not listening. server.log:"
  Write-Output '----------------------------------------'
  if (Test-Path -LiteralPath $LogPath) {
    Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
  } else {
    Write-Output '(server.log does not exist)'
  }
  Write-Output '----------------------------------------'
  Write-Output 'Scheduled task status:'
  Get-ScheduledTask AnthonyAI |
    Get-ScheduledTaskInfo |
    Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns |
    Format-List |
    Out-String
  exit 1
} catch {
  Write-Output ('[X] probe failed: ' + $_.Exception.Message)
  exit 1
}
