param(
  [Parameter(Mandatory=$true)][string]$PublishPath,
  [ValidateSet('Install','Remove')][string]$Mode = 'Install',
  [int]$StaticPort = 3889,
  [ValidateSet('127.0.0.1','localhost')][string]$StaticHost = '127.0.0.1',
  [string]$SnapshotPath = ''
)

$ErrorActionPreference = 'Stop'

function New-EmptyDocument {
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  [void]$doc.AppendChild($doc.CreateXmlDeclaration('1.0', 'UTF-8', 'yes'))
  [void]$doc.AppendChild($doc.CreateElement('jsplugins'))
  return $doc
}

function Load-PublishDocument([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return New-EmptyDocument }
  $doc = New-Object System.Xml.XmlDocument
  $doc.PreserveWhitespace = $true
  try {
    $doc.Load($Path)
  } catch {
    throw "publish.xml 无法解析，已拒绝覆盖: $Path ($($_.Exception.Message))"
  }
  if (-not $doc.DocumentElement -or $doc.DocumentElement.Name -ne 'jsplugins') {
    throw "publish.xml 根节点不是 <jsplugins>，已拒绝覆盖: $Path"
  }
  return $doc
}

function Test-ProductNode([System.Xml.XmlNode]$Node) {
  if ($Node.NodeType -ne [System.Xml.XmlNodeType]::Element -or $Node.Name -ne 'jspluginonline') { return $false }
  $name = [string]$Node.GetAttribute('name')
  return $name -match '^(?i:(?:lingxi-ai|anthony-ai)(?:-|$))'
}

$fullPath = [System.IO.Path]::GetFullPath($PublishPath)
$parent = Split-Path -Parent $fullPath
if (-not $parent) { throw 'PublishPath 必须包含父目录' }
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

$doc = Load-PublishDocument $fullPath

if ($SnapshotPath) {
  $snapshotFull = [System.IO.Path]::GetFullPath($SnapshotPath)
  $snapshotParent = Split-Path -Parent $snapshotFull
  if (-not (Test-Path -LiteralPath $snapshotParent)) { New-Item -ItemType Directory -Path $snapshotParent -Force | Out-Null }
  if (Test-Path -LiteralPath $fullPath) { Copy-Item -LiteralPath $fullPath -Destination $snapshotFull -Force }
}

$root = $doc.DocumentElement
$toRemove = @($root.ChildNodes | Where-Object { Test-ProductNode $_ })
foreach ($node in $toRemove) { [void]$root.RemoveChild($node) }

if ($Mode -eq 'Install') {
  if ($StaticPort -lt 1 -or $StaticPort -gt 65535) { throw "无效静态端口: $StaticPort" }
  foreach ($host in @('wps','et','wpp','pdf')) {
    $node = $doc.CreateElement('jspluginonline')
    $node.SetAttribute('name', "anthony-ai-$host")
    $node.SetAttribute('type', $host)
    $node.SetAttribute('url', "http://${StaticHost}:$StaticPort/$host/")
    $node.SetAttribute('enable', 'enable')
    $node.SetAttribute('install', 'null')
    [void]$root.AppendChild($node)
  }
}

$remainingElements = @($root.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Element })
if ($Mode -eq 'Remove' -and $remainingElements.Count -eq 0) {
  if (Test-Path -LiteralPath $fullPath) { Remove-Item -LiteralPath $fullPath -Force }
  Write-Output "REMOVED=$fullPath"
  exit 0
}

$temp = Join-Path $parent ('.anthony-publish-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$backup = Join-Path $parent ('.anthony-publish-' + [Guid]::NewGuid().ToString('N') + '.bak')
try {
  $settings = New-Object System.Xml.XmlWriterSettings
  $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
  $settings.Indent = $true
  $settings.NewLineChars = "`r`n"
  $settings.NewLineHandling = [System.Xml.NewLineHandling]::Replace
  $writer = [System.Xml.XmlWriter]::Create($temp, $settings)
  try { $doc.Save($writer) } finally { $writer.Dispose() }

  $verify = Load-PublishDocument $temp
  $productNames = @($verify.DocumentElement.ChildNodes | Where-Object { Test-ProductNode $_ } | ForEach-Object { $_.GetAttribute('name') })
  if ($Mode -eq 'Install') {
    $expected = @('anthony-ai-wps','anthony-ai-et','anthony-ai-wpp','anthony-ai-pdf')
    if ((@($productNames | Sort-Object) -join '|') -ne (@($expected | Sort-Object) -join '|')) {
      throw '写入复验失败：Anthony AI 条目不完整或存在旧品牌条目'
    }
  } elseif ($productNames.Count -ne 0) {
    throw '卸载复验失败：仍存在产品条目'
  }

  if (Test-Path -LiteralPath $fullPath) {
    [System.IO.File]::Replace($temp, $fullPath, $backup, $true)
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($temp, $fullPath)
  }
} finally {
  Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
}

Write-Output "UPDATED=$fullPath"
