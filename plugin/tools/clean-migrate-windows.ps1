param(
  [ValidateSet('Audit','PrepareStorage','Clean')][string]$Mode = 'Audit',
  [switch]$ConfirmStorageCleaned
)

$ErrorActionPreference = 'Stop'
$ProductAppId = '{B2A4E27D-3E5C-4F1A-8C6B-2A1D4F7E0011}_is1'
$CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$CurrentSid = $CurrentIdentity.User.Value
$CurrentSession = (Get-Process -Id $PID).SessionId
$CurrentProfile = $env:USERPROFILE
$PublishPath = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons\publish.xml'
$ToolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PublishTool = Join-Path $ToolDir 'update-wps-publish.ps1'
$ReportDir = Join-Path $env:TEMP ('anthony-migration-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Assert-TargetUser {
  $explorer = Get-Process explorer -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $CurrentSession } |
    Select-Object -First 1
  if (-not $explorer) {
    throw "当前 PowerShell 会话 $CurrentSession 没有对应 explorer.exe；请由实际使用 WPS 的用户在其桌面会话中运行"
  }
  $owner = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $explorer.Id) |
    Invoke-CimMethod -MethodName GetOwner
  $ownerId = if ($owner.Domain) { "$($owner.Domain)\$($owner.User)" } else { $owner.User }
  $ownerSid = ([System.Security.Principal.NTAccount]$ownerId).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne $CurrentSid) {
    throw "当前 PowerShell 用户 SID ($CurrentSid) 不是本桌面 WPS 用户 SID ($ownerSid)，禁止继续"
  }
}

function Get-UninstallEntries {
  $locations = @(
    @{ Scope='HKCU'; Path='Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall' },
    @{ Scope='HKLM64'; Path='Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall' },
    @{ Scope='HKLM32'; Path='Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }
  )
  $items = @()
  foreach ($location in $locations) {
    if (-not (Test-Path $location.Path)) { continue }
    Get-ChildItem $location.Path -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      $name = [string]$p.DisplayName
      $publisher = [string]$p.Publisher
      $install = [string]$p.InstallLocation
      $isProduct = ($_.PSChildName -eq $ProductAppId) -or
        ($name -match '(?i)(Anthony AI|Lingxi AI|灵犀AI)') -or
        ($install -match '(?i)\\(AnthonyAI|LingxiAI)(?:\\|$)')
      if ($isProduct) {
        $items += [pscustomobject]@{
          Scope=$location.Scope; RegistryPath=$_.PSPath; KeyName=$_.PSChildName
          DisplayName=$name; Publisher=$publisher; InstallLocation=$install
          UninstallString=[string]$p.UninstallString; QuietUninstallString=[string]$p.QuietUninstallString
        }
      }
    }
  }
  return $items
}

function Get-CanonicalSafeProductRoot([string]$Path) {
  if (-not $Path -or $Path.Contains('*') -or $Path.Contains('?') -or $Path.Contains('%')) { throw "不安全或未展开路径: $Path" }
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "拒绝处理 reparse point/junction/symlink: $Path" }
  $full = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
  $root = [IO.Path]::GetPathRoot($full).TrimEnd('\')
  if ($full.Length -lt 12 -or $full -eq $root -or $full -eq $CurrentProfile.TrimEnd('\')) { throw "拒绝处理过宽目录: $full" }
  $leaf = Split-Path -Leaf $full
  if ($leaf -notin @('.lingxi-ai','.anthony-ai','LingxiAI','AnthonyAI')) {
    $marker = Test-Path -LiteralPath (Join-Path $full 'plugin\tools\post-install-windows.bat')
    if (-not $marker) { throw "目录缺少产品标记，拒绝处理: $full" }
  }
  return $full
}

function Parse-Uninstaller([pscustomobject]$Entry) {
  $raw = if ($Entry.QuietUninstallString) { $Entry.QuietUninstallString } else { $Entry.UninstallString }
  if (-not $raw) { throw "卸载项没有 UninstallString: $($Entry.DisplayName)" }
  $exe = ''
  if ($raw -match '^\s*"([^"]+\.exe)"') { $exe = $Matches[1] }
  elseif ($raw -match '^\s*([^\s]+\.exe)') { $exe = $Matches[1] }
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { throw "无法安全解析卸载器: $raw" }
  $exe = [IO.Path]::GetFullPath($exe)
  if ((Split-Path -Leaf $exe) -notmatch '^unins\d*\.exe$') { throw "卸载器文件名不符合 Inno 规则: $exe" }
  if ($Entry.InstallLocation) {
    $install = [IO.Path]::GetFullPath($Entry.InstallLocation).TrimEnd('\')
    if (-not $exe.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "卸载器不在已登记安装目录内: $exe"
    }
  } else {
    $parent = Split-Path -Parent $exe
    $leaf = Split-Path -Leaf $parent
    $hasMarker = Test-Path -LiteralPath (Join-Path $parent 'plugin\tools\post-install-windows.bat')
    if ($leaf -notin @('LingxiAI','AnthonyAI') -and -not $hasMarker) {
      throw "卸载项缺少 InstallLocation，且卸载器目录没有产品标记: $exe"
    }
  }
  return $exe
}

function Get-ProductState {
  $entries = @(Get-UninstallEntries)
  $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -in @('LingxiAI','AnthonyAI') } | ForEach-Object {
    [pscustomobject]@{ Name=$_.TaskName; Actions=@($_.Actions | ForEach-Object { ([string]$_.Execute) + ' ' + ([string]$_.Arguments) + ' ' + ([string]$_.WorkingDirectory) }) }
  })
  $runPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $run = @()
  if (Test-Path $runPath) {
    $props = Get-ItemProperty $runPath
    foreach ($name in @('LingxiAI','AnthonyAI')) {
      if ($null -ne $props.$name) { $run += [pscustomobject]@{ Name=$name; Value=[string]$props.$name } }
    }
  }
  $processes = @(Get-CimInstance Win32_Process | Where-Object {
    (([string]$_.CommandLine) + ' ' + ([string]$_.ExecutablePath)) -match '(?i)(\\\.lingxi-ai\\|\\\.anthony-ai\\|\\LingxiAI\\|\\AnthonyAI\\)'
  } | Select-Object ProcessId,Name,ExecutablePath,CommandLine)
  $dirs = @($entries.InstallLocation + @(
    (Join-Path $CurrentProfile '.lingxi-ai'),
    (Join-Path $CurrentProfile '.anthony-ai'),
    (Join-Path $env:LOCALAPPDATA 'Programs\LingxiAI'),
    (Join-Path $env:LOCALAPPDATA 'Programs\AnthonyAI'),
    (Join-Path $env:ProgramFiles 'LingxiAI'),
    (Join-Path $env:ProgramFiles 'AnthonyAI')
  ) | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object { [pscustomobject]@{ Path=$_; Exists=(Test-Path -LiteralPath $_) } })
  [pscustomobject]@{
    TargetUser=$CurrentIdentity.Name; TargetSid=$CurrentSid; SessionId=$CurrentSession
    Profile=$CurrentProfile; PublishPath=$PublishPath
    UninstallEntries=$entries; Tasks=$tasks; RunValues=$run; Processes=$processes; Directories=$dirs
  }
}

Assert-TargetUser
New-Item -ItemType Directory -Path $ReportDir -Force | Out-Null
$before = Get-ProductState
$before | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ReportDir 'before.json') -Encoding UTF8
Write-Output ("REPORT_DIR=" + $ReportDir)
Write-Output ($before | ConvertTo-Json -Depth 8)

if ($Mode -eq 'Audit') { exit 0 }
if ($Mode -eq 'PrepareStorage') {
  if (Get-Process wps,et,wpp,pdf,wpsoffice -ErrorAction SilentlyContinue) {
    throw '检测到 WPS 仍在运行。请先保存文档并完全退出 WPS'
  }
  foreach ($task in $before.Tasks) {
    $joined = ($task.Actions -join ' ')
    if ($joined -notmatch '(?i)(\.lingxi-ai|\.anthony-ai|\\LingxiAI\\|\\AnthonyAI\\)') {
      throw "同名任务 Action 不属于产品，拒绝停止: $($task.Name)"
    }
    Stop-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
  }
  foreach ($proc in $before.Processes) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop }
  Write-Output '[OK] 已安全暂停旧/当前产品后台服务，可在原静态端口运行四宿主清理页'
  exit 0
}
if (-not $ConfirmStorageCleaned) { throw 'Clean 模式要求先在 WPS 四宿主完成 cleanup-storage 页面，并传入 -ConfirmStorageCleaned' }
if (Get-Process wps,et,wpp,pdf,wpsoffice -ErrorAction SilentlyContinue) {
  throw '检测到 WPS 仍在运行。请先保存文档并完全退出 WPS'
}

$snapshot = Join-Path $ReportDir 'publish-before.xml'
if (Test-Path -LiteralPath $PublishPath) {
  & $PublishTool -PublishPath $PublishPath -Mode Remove -SnapshotPath $snapshot | Out-Null
}

foreach ($proc in $before.Processes) {
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
}

foreach ($task in $before.Tasks) {
  $joined = ($task.Actions -join ' ')
  if ($joined -notmatch '(?i)(\.lingxi-ai|\.anthony-ai|\\LingxiAI\\|\\AnthonyAI\\)') {
    throw "同名任务 Action 不属于产品，拒绝删除: $($task.Name)"
  }
  Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($run in $before.RunValues) {
  if ($run.Value -notmatch '(?i)(\.lingxi-ai|\.anthony-ai|\\LingxiAI\\|\\AnthonyAI\\)') {
    throw "同名 Run 值不属于产品，拒绝删除: $($run.Name)"
  }
  Remove-ItemProperty -Path $runKey -Name $run.Name -Force
}

$uninstallers = @{}
foreach ($entry in $before.UninstallEntries) {
  $exe = Parse-Uninstaller $entry
  $uninstallers[$exe.ToLowerInvariant()] = $exe
}
foreach ($exe in $uninstallers.Values) {
  $p = Start-Process -FilePath $exe -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "旧卸载器失败: $exe (exit=$($p.ExitCode))" }
}

if (Test-Path -LiteralPath $snapshot) {
  $publishParent = Split-Path -Parent $PublishPath
  if (-not (Test-Path -LiteralPath $publishParent)) { New-Item -ItemType Directory -Path $publishParent -Force | Out-Null }
  Copy-Item -LiteralPath $snapshot -Destination $PublishPath -Force
  & $PublishTool -PublishPath $PublishPath -Mode Remove | Out-Null
}

$candidateDirs = @($before.Directories | Where-Object { $_.Exists } | ForEach-Object { $_.Path })
foreach ($candidate in ($candidateDirs | Sort-Object -Unique)) {
  $safe = Get-CanonicalSafeProductRoot $candidate
  if ($safe -and (Test-Path -LiteralPath $safe)) { Remove-Item -LiteralPath $safe -Recurse -Force }
}

$after = Get-ProductState
$after | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ReportDir 'after.json') -Encoding UTF8
$remaining = @($after.UninstallEntries).Count + @($after.Tasks).Count + @($after.RunValues).Count + @($after.Processes).Count + @($after.Directories | Where-Object Exists).Count
if ($remaining -ne 0) { throw "清理后仍有 $remaining 项产品状态，详见 $ReportDir\after.json" }

Write-Output '[OK] Windows 两品牌运行状态已清空；请继续构建并安装 Anthony AI'
