param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$TargetSid,
  [Parameter(Mandatory=$true)][string]$TargetUser,
  [Parameter(Mandatory=$true)][string]$SourceCommit,
  [Parameter(Mandatory=$true)][string]$InstallDir,
  [Parameter(Mandatory=$true)][string]$Runtime,
  [Parameter(Mandatory=$true)][int]$StaticPort,
  [Parameter(Mandatory=$true)][int]$ProxyPort
)

$ErrorActionPreference = 'Stop'
$marker = [ordered]@{
  ok = $true
  targetSid = $TargetSid
  targetUser = $TargetUser
  sourceCommit = $SourceCommit
  installDir = [IO.Path]::GetFullPath($InstallDir)
  runtime = [IO.Path]::GetFullPath($Runtime)
  staticPort = $StaticPort
  proxyPort = $ProxyPort
  completedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$parent = Split-Path -Parent $Path
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$marker | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
$verify = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
if (-not $verify.ok -or $verify.targetSid -ne $TargetSid -or $verify.sourceCommit -ne $SourceCommit) {
  throw '安装完成标记复验失败'
}
