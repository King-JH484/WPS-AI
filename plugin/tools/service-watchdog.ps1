param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$RunnerPath,
  [Parameter(Mandatory=$true)][string]$ScriptPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [int]$IdleSeconds = 30,
  [int]$PollSeconds = 2,
  [switch]$StartNow
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-WatchdogLog([string]$Message) {
  try {
    $dir = Split-Path -Parent $LogPath
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogPath -Encoding UTF8 -Value ("[{0}] [watchdog] {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message)
  } catch {}
}

function Get-WpsHostProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @('wps.exe', 'et.exe', 'wpp.exe', 'pdf.exe', 'wpsoffice.exe')
    } |
    Where-Object {
      $cmd = [string]$_.CommandLine
      if (-not $cmd) { return $true }

      # WPS keeps preview/preload/CEF helper processes after the visible window closes.
      # They should not keep the Lingxi Node service alive.
      if ($cmd -match '(?i)(/Preview\b|-Embedding\b|/from_prome\b|/prome-prestart-type=|CefRenderEntryPoint|promecefpluginhost|--type=renderer)') {
        return $false
      }

      # 修 ribbon 消失根因：`Run -Entry=` 既可能是预启动进程，也可能是**用户真实主窗口**
      # （WPS 12.1.0.26895 起主进程命令行同样带 `Run -Entry=EntryPoint`）。
      # 一刀切排除会让 watchdog 误判"没有 WPS 在跑" → 停掉本地服务 → WPS 拉不到
      # ribbon.xml → 插件入口消失。改用「是否有可见主窗口」区分：预启动无窗口，主进程有。
      if ($cmd -match '(?i)Run\s+-Entry=') {
        try {
          $proc = Get-Process -Id $_.ProcessId -ErrorAction Stop
          return ($proc.MainWindowHandle -ne 0)
        } catch {
          return $false
        }
      }

      return $true
    }
}

function Get-LingxiNodeProcess {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -eq 'node.exe') -and
      (($_.CommandLine -like '*service-runner.js*') -or
       ($_.CommandLine -like '*serve-permanent.js*') -or
       ($_.CommandLine -like '*proxy-server.js*')) -and
      ($_.CommandLine -like '*\.lingxi-ai*')
    }
}

function Test-StaticPort {
  $client = $null
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $connect = $client.BeginConnect('127.0.0.1', $StaticPort, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500, $false)) {
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

function Start-LingxiService {
  if (Test-StaticPort) { return }
  if (-not (Test-Path $NodeExe)) { Write-WatchdogLog "node missing: $NodeExe"; return }
  if (-not (Test-Path $RunnerPath)) { Write-WatchdogLog "runner missing: $RunnerPath"; return }
  if (-not (Test-Path $ScriptPath)) { Write-WatchdogLog "script missing: $ScriptPath"; return }

  $args = @(
    "`"$RunnerPath`"",
    "--log", "`"$LogPath`"",
    "--static-port", "$StaticPort",
    "--proxy-port", "$ProxyPort",
    "--script", "`"$ScriptPath`"",
    "--root", "`"$RootDir`""
  ) -join ' '

  Write-WatchdogLog "starting node service on $StaticPort/$ProxyPort"
  Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $RootDir -WindowStyle Hidden | Out-Null
}

function Stop-LingxiService {
  Write-WatchdogLog "stopping node service after idle"
  Get-LingxiNodeProcess | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force } catch {}
  }
}

Write-WatchdogLog "watchdog started; idleSeconds=$IdleSeconds pollSeconds=$PollSeconds startNow=$StartNow"

$lastSeenWps = if ($StartNow) { Get-Date } else { $null }
if ($StartNow) { Start-LingxiService }

while ($true) {
  $hasWps = [bool](Get-WpsHostProcess)
  if ($hasWps) {
    $lastSeenWps = Get-Date
    Start-LingxiService
  } elseif ($lastSeenWps -and ((Get-Date) - $lastSeenWps).TotalSeconds -ge $IdleSeconds) {
    Stop-LingxiService
    $lastSeenWps = $null
  }
  Start-Sleep -Seconds $PollSeconds
}
