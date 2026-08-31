param(
  [Parameter(Mandatory=$true)][string]$PluginDir
)

$ErrorActionPreference = 'Stop'

$plugin = (Resolve-Path -LiteralPath $PluginDir).Path
$targets = @('node_modules', 'dist', 'dist-permanent', 'test', '.git')

foreach ($name in $targets) {
  $path = Join-Path $plugin $name
  if (-not (Test-Path -LiteralPath $path)) { continue }

  $resolved = (Resolve-Path -LiteralPath $path).Path
  if ($resolved.StartsWith($plugin, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

Get-ChildItem -LiteralPath $plugin -Filter '*.log' -File -ErrorAction SilentlyContinue |
  Remove-Item -Force

foreach ($launcherName in @('lingxi-launcher.exe', 'anthony-launcher.exe')) {
  $launcherPath = Join-Path $plugin (Join-Path 'tools' $launcherName)
  if (Test-Path -LiteralPath $launcherPath) {
    Remove-Item -LiteralPath $launcherPath -Force
  }
}

$runtime = Join-Path $plugin 'runtime'
if (Test-Path -LiteralPath $runtime) {
  Get-ChildItem -LiteralPath $runtime -Recurse -File |
    Where-Object {
      $_.Name -like '*.zip' -or
      $_.Name -like '*.tar.gz' -or
      $_.Name -like '*.tar.xz'
    } |
    Remove-Item -Force
}
