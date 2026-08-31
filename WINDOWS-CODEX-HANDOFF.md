# Anthony AI Windows 干净迁移 — Codex 全权交接

> 交给目标 Windows 电脑上的 Codex 执行。目标电脑曾安装品牌更换前的“灵犀AI / LingxiAI”。用户已明确授权：旧 API Key、模型配置、历史会话、缓存和日志全部删除，不做迁移。

## 0. 任务目标与完成边界

你需要在实际使用 WPS 的 Windows 用户桌面会话中完成：

1. 盘点并彻底清除旧 Lingxi AI 和失败/旧 Anthony AI 的运行状态与用户数据。
2. 保护用户文档和其他厂商的 WPS JS 加载项。
3. 从 `https://github.com/King-JH484/WPS-AI.git` 获取干净源码。
4. 在 Windows 本机用 Inno Setup 6 构建、安装 Anthony AI。
5. 验证 Word、Excel、PowerPoint、PDF、历史会话、provider 设置、后台性能和登录后冷启动。
6. 输出可审计的最终报告。

只有 Windows 真机清理复检、安装探活、四宿主验收和一次注销/重启后复验全部通过，才能宣布“正常使用”。本仓库在 Apple Silicon Mac 上通过的测试不能替代本任务。

## 1. 不可违反的安全规则

- 开始前提示用户保存所有 WPS 文档；未经确认不得强制结束 WPS。
- 全程以实际使用 WPS 的同一个 Windows 用户运行。不要用另一个管理员账户的桌面、`HKCU`、`USERPROFILE` 或 `APPDATA` 代替目标用户。
- 管理员权限只用于旧卸载器或受保护目录；若 UAC 切换成另一个账户，返回目标用户会话继续用户态步骤。
- 不删除或重装 WPS Office 本体。
- 不删除任何 Word、Excel、PowerPoint、PDF 用户文档。
- 不删除整个 `%APPDATA%\kingsoft`、WPS WebView 用户数据目录或整个 `publish.xml`。
- 不删除第三方 `<jspluginonline>` 节点。
- 不按 `node.exe`、任务名或目录名盲目杀进程/删任务；必须校验命令行、Action、Run 值和规范化产品根路径。
- 不对磁盘根、`%USERPROFILE%`、`%APPDATA%`、`%LOCALAPPDATA%`、`%ProgramFiles%` 或含通配符/未展开变量的路径递归删除。
- 不使用 `Invoke-Expression` 执行卸载命令。
- 日志不得记录 API Key、Authorization、OAuth token、provider 配置值；存储清理只记录键名。
- 遇到 XML 解析失败、多个交互会话、目标 SID 不一致、同名任务指向无关程序、旧卸载失败或目录安全校验失败时立即停止，不得扩大删除范围绕过。

## 2. 建立迁移工作目录并克隆源码

在目标用户的普通 PowerShell 中执行。不要先删除任何已存在目录；使用新的时间戳目录：

```powershell
$ErrorActionPreference = 'Stop'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$WorkRoot = Join-Path $env:USERPROFILE "Documents\AnthonyAI-Migration-$Stamp"
$Repo = Join-Path $WorkRoot 'WPS-AI'
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
git clone https://github.com/King-JH484/WPS-AI.git $Repo
Set-Location $Repo

$Origin = git remote get-url origin
$Commit = git rev-parse HEAD
$RemoteCommit = (git ls-remote origin refs/heads/main).Split("`t")[0]
$Dirty = git status --porcelain
if ($Origin -notmatch 'github\.com[/:]King-JH484/WPS-AI(?:\.git)?$') { throw "远端错误: $Origin" }
if ($Commit -ne $RemoteCommit) { throw "本地 HEAD 与 origin/main 不一致: $Commit / $RemoteCommit" }
if ($Dirty) { throw "新克隆仓库不干净: $Dirty" }

$Node = Join-Path $Repo 'plugin\runtime\node-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $Node)) { throw "缺少内置 Windows Node: $Node" }
& $Node --version
```

把 `$WorkRoot`、`$Repo`、`$Commit`、`$Origin` 记录到最终报告。该克隆只是迁移工具与待安装源码，不代表已经安装。

## 3. 确认目标用户、WPS 和旧状态

```powershell
Set-Location $Repo
whoami
whoami /user
Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture
$PSVersionTable.PSVersion
git --version

powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
  (Join-Path $Repo 'plugin\tools\clean-migrate-windows.ps1') -Mode Audit
```

脚本会在 `%TEMP%\anthony-migration-*\before.json` 留盘点报告并输出 `REPORT_DIR=...`。检查：

- `TargetSid` 属于当前桌面中实际使用 WPS 的用户。
- 若有多个登录/RDP 会话，先让用户明确选择并退出其他会话；不要猜。
- 记录旧卸载项、安装目录、任务、Run 值、相关进程和 `publish.xml` 路径。
- 用 WPS“帮助/关于”或可执行文件版本确认 WPS 版本；建议目标 Windows WPS 12.1.0.26884 x64。

若盘点脚本因 SID、会话或安全校验失败，先解决身份问题，不得直接手工 `Remove-Item -Recurse`。

## 4. 清除四宿主 WebView / PluginStorage 旧数据

单纯删除 `.lingxi-ai` 不够；旧 provider、API Key 和历史可能仍在 WPS 的 WebView `localStorage` 或 `Application.PluginStorage`。必须在 Word、Excel、PowerPoint、PDF 四个宿主分别运行专用清理页。

### 4.1 记录旧产品使用的原始静态源

```powershell
$Publish = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons\publish.xml'
$ProductUrls = @()
if (Test-Path -LiteralPath $Publish) {
  [xml]$PublishXml = Get-Content -LiteralPath $Publish -Raw
  $ProductUrls = @($PublishXml.jsplugins.jspluginonline | Where-Object {
    $_.name -match '^(?i)(lingxi-ai|anthony-ai)(-|$)'
  } | ForEach-Object { [string]$_.url } | Sort-Object -Unique)
}
$ProductUrls
```

通常应为 `http://127.0.0.1:3889/...`。提取旧 origin：

```powershell
$Origins = @($ProductUrls | ForEach-Object {
  $u = [Uri]$_
  "$($u.Scheme)://$($u.Host):$($u.Port)"
} | Sort-Object -Unique)
if (-not $Origins.Count) { $Origins = @('http://127.0.0.1:3889') }
if ($Origins.Count -ne 1) {
  throw "发现多个旧产品 origin，需要逐个 origin 完成清理，不得只清一个: $($Origins -join ', ')"
}
$CleanupOrigin = [Uri]$Origins[0]
if ($CleanupOrigin.Scheme -ne 'http' -or $CleanupOrigin.Host -notin @('127.0.0.1','localhost')) {
  throw "不支持或不安全的旧 origin: $CleanupOrigin"
}
$CleanupPort = $CleanupOrigin.Port
$CleanupHost = $CleanupOrigin.Host
```

如果确实有多个合法回环 origin，按本节完整重复每一个 origin，且最终报告逐项列出。

### 4.2 保存文档并暂停旧后台服务

请用户保存文档并完全退出 WPS（包括托盘中的 WPS）。确认以下进程不再运行：

```powershell
Get-Process wps,et,wpp,pdf,wpsoffice -ErrorAction SilentlyContinue
```

然后只暂停已经过路径验证的旧/当前产品任务与进程：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
  (Join-Path $Repo 'plugin\tools\clean-migrate-windows.ps1') -Mode PrepareStorage
```

确认旧静态端口空闲：

```powershell
Get-NetTCPConnection -LocalPort $CleanupPort -State Listen -ErrorAction SilentlyContinue
```

如果仍被占用，解析 PID 和完整命令行；只有路径明确属于 `.lingxi-ai`、`.anthony-ai`、`LingxiAI`、`AnthonyAI` 才能停止。无关程序占用时停止任务并报告，不得杀无关进程或偷偷换端口，因为换端口会换 localStorage origin。

### 4.3 生成并运行专用清理变体

```powershell
$CleanupRoot = Join-Path $WorkRoot 'storage-cleanup-runtime'
& $Node (Join-Path $Repo 'plugin\tools\prepare-storage-cleanup.js') --out $CleanupRoot
if ($LASTEXITCODE -ne 0) { throw '生成四宿主清理变体失败' }

$CleanupLog = Join-Path $WorkRoot 'cleanup-server.log'
$CleanupErr = Join-Path $WorkRoot 'cleanup-server-error.log'
$CleanupServerScript = Join-Path $Repo 'plugin\tools\serve-storage-cleanup.js'
$CleanupProcess = Start-Process -FilePath $Node -ArgumentList @(
  "`"$CleanupServerScript`"",
  '--root', "`"$CleanupRoot`"",
  '--port', [string]$CleanupPort
) -RedirectStandardOutput $CleanupLog -RedirectStandardError $CleanupErr -PassThru

Start-Sleep -Seconds 2
$Health = Invoke-RestMethod "http://$CleanupHost`:$CleanupPort/health"
if (-not $Health.ok -or $Health.mode -ne 'storage-cleanup') { throw '清理服务器探活失败' }

powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
  (Join-Path $Repo 'plugin\tools\update-wps-publish.ps1') `
  -PublishPath $Publish -Mode Install -StaticPort $CleanupPort -StaticHost $CleanupHost
```

### 4.4 四宿主逐一执行

依次操作，不能只测 Word：

1. 打开 WPS 文字，点击功能区 Anthony AI 主入口。
2. 清理页面必须显示“清理完成”，`document.body.dataset.status` 必须是 `complete`。
3. 完全退出文字宿主。
4. 对 WPS 表格重复。
5. 对 WPS 演示重复。
6. 选一个非敏感本地 PDF，彻底关闭 WPS 后直接双击该 PDF，再点击 Anthony AI，重复清理。

若某宿主显示 `partial` 或“未暴露 PluginStorage”，不得确认完成；记录宿主与 WPS 版本并诊断对象模型，不能直接跳过。

页面日志只允许记录删除键名和数量，不得记录任何旧值。完成四宿主后，保存四次结果截图或文字记录，完全退出 WPS并停止清理服务器：

```powershell
Stop-Process -Id $CleanupProcess.Id -Force
Get-NetTCPConnection -LocalPort $CleanupPort -State Listen -ErrorAction SilentlyContinue
```

## 5. 执行彻底旧内容清理

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
  (Join-Path $Repo 'plugin\tools\clean-migrate-windows.ps1') `
  -Mode Clean -ConfirmStorageCleaned
```

该脚本会：

- 固定并复核目标用户 SID/桌面会话。
- 在插件目录外备份并解析 `publish.xml`。
- 校验相关任务、Run 值、进程和产品根路径。
- 安全解析并调用登记的旧 Inno 卸载器。
- 恢复第三方 WPS 加载项节点，只移除 `lingxi-ai-*` / `anthony-ai-*`。
- 删除经验证的 `.lingxi-ai`、`.anthony-ai` 和旧/失败安装目录。
- 输出 `after.json` 并在仍有残留时返回失败。

若 UAC 要求管理员权限，只允许已验证的旧卸载器请求提权。若脚本因受保护目录无法删除而停止，先记录精确目录、AppId、卸载器和 ACL，再针对这个明确目录处理；禁止扩大到整个 Program Files。

清理成功后再次运行：

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File `
  (Join-Path $Repo 'plugin\tools\clean-migrate-windows.ps1') -Mode Audit
```

验收要求：两品牌卸载项、任务、Run 值、产品进程和产品目录均为零；`publish.xml` 中两品牌节点为零，第三方节点与迁移前语义一致。

## 6. Windows 本机源码与安装链验证

### 6.1 静态门禁与定向测试

```powershell
Set-Location $Repo
& $Node plugin\tools\validate-windows-package.js .
if ($LASTEXITCODE -ne 0) { throw 'Windows 安装包静态门禁失败' }

& $Node --test `
  plugin\test\storage-cleanup.test.js `
  plugin\test\windows-migration-contract.test.js `
  plugin\test\conversation-mailbox.test.js `
  plugin\test\minimal-pdf-repair.test.js `
  plugin\test\pdf-path-detection.test.js `
  plugin\test\provider-settings-store.test.js `
  plugin\test\ribbon-callbacks.test.js
if ($LASTEXITCODE -ne 0) { throw '关键定向测试失败' }
```

定向测试必须 100% 通过。

### 6.2 完整测试

```powershell
$Tests = @(Get-ChildItem (Join-Path $Repo 'plugin\test\*.test.js') | Sort-Object FullName | ForEach-Object FullName)
Push-Location (Join-Path $Repo 'plugin')
& $Node --test $Tests 2>&1 | Tee-Object (Join-Path $WorkRoot 'full-node-tests.log')
$FullTestExit = $LASTEXITCODE
Pop-Location
```

维护端 Apple Silicon Mac 基线为：708 项、700 通过、7 失败、1 跳过。已知失败包括 CSS 间距、两项 i18n 覆盖、`multimodal-error.test.js`、两项 Ollama VM `setTimeout`、以及平台相关 `pick-node`。Windows 上 `pick-node` 应因内置 `node.exe` 存在而通过。不得只比较数量；逐条核对失败集合，任何新的 Windows 安装/迁移/PDF/历史/provider/CPU 相关失败都必须修复。

### 6.3 安装 Inno Setup 6

优先使用已安装的 Inno Setup 6。若没有，可先执行 `winget search "Inno Setup"`，核对发布者为 JRSoftware 后安装；或从 `https://jrsoftware.org/isdl.php` 获取。不要安装来源不明的编译器。

定位编译器：

```powershell
$IsccCandidates = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
$Iscc = $IsccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Iscc) { throw '未找到 Inno Setup 6 ISCC.exe' }
```

### 6.4 构建并计算安装器哈希

```powershell
Set-Location $Repo
$Commit = git rev-parse HEAD
& $Iscc "/DSourceCommit=$Commit" (Join-Path $Repo 'installer\anthony-ai.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 编译失败' }

$Setup = Get-ChildItem (Join-Path $Repo 'dist\anthony-ai-*-setup.exe') |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Setup) { throw '没有生成 Windows 安装器' }
$SetupHash = Get-FileHash -LiteralPath $Setup.FullName -Algorithm SHA256
$SetupHash | Format-List
```

不要从 Mac 复制一个未经 Windows 编译/运行的 EXE 来替代此步骤。

## 7. 安装并进行机器级验收

运行安装器（保持目标 WPS 用户身份，不要选择另一管理员账户安装）：

```powershell
$Install = Start-Process -FilePath $Setup.FullName -Wait -PassThru
if ($Install.ExitCode -ne 0) { throw "安装器失败: $($Install.ExitCode)" }
```

安装器应该安装到：

```text
%LOCALAPPDATA%\Programs\AnthonyAI
```

不得安装到任何包含 `LingxiAI` 的目录。检查完整成功标记：

```powershell
$MarkerPath = Join-Path $env:USERPROFILE '.anthony-ai\install-complete.json'
if (-not (Test-Path -LiteralPath $MarkerPath)) { throw '缺少完整安装成功标记' }
$Marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
$Marker | Format-List
if (-not $Marker.ok) { throw '成功标记 ok=false' }
if ($Marker.targetSid -ne ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) { throw '成功标记 SID 错误' }
if ($Marker.sourceCommit -ne $Commit) { throw '安装源码提交不一致' }
if ($Marker.installDir -match '(?i)LingxiAI') { throw '错误沿用了旧品牌目录' }
```

继续验证：

```powershell
$Task = Get-ScheduledTask -TaskName AnthonyAI
$TaskInfo = Get-ScheduledTaskInfo -TaskName AnthonyAI
$Task | Select-Object TaskName,State,Principal,Actions | Format-List
$TaskInfo | Format-List
if (Get-ScheduledTask -TaskName LingxiAI -ErrorAction SilentlyContinue) { throw '旧 LingxiAI 任务仍存在' }

$Run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
if ($Run.LingxiAI) { throw '旧 LingxiAI Run 值仍存在' }

Invoke-RestMethod "http://127.0.0.1:$($Marker.staticPort)/health"
Invoke-RestMethod "http://127.0.0.1:$($Marker.proxyPort)/healthz"
foreach ($HostName in @('wps','et','wpp','pdf')) {
  foreach ($File in @('manifest.json','ribbon.xml','index.html')) {
    $Uri = "http://127.0.0.1:$($Marker.staticPort)/$HostName/$File"
    $Response = Invoke-WebRequest $Uri -UseBasicParsing
    if ($Response.StatusCode -ne 200) { throw "路由失败: $Uri" }
  }
}
```

解析 `publish.xml`，必须恰有四个 `anthony-ai-{wps,et,wpp,pdf}`，零个 `lingxi-ai-*`；与清理前快照比较时，第三方节点的 name/type/url/所有属性和子节点语义不能改变。

## 8. WPS 四宿主功能验收

使用非重要测试文件，逐项记录截图/结果：

### Word

- 功能区显示 “Anthony AI”。
- “打开 Anthony AI”入口存在且可点击。
- 侧栏打开后宿主识别为文字。
- 新建一条测试会话，关闭侧栏和 WPS，重新打开同一文档后历史可恢复。

### Excel

- 功能区、主入口和侧栏正常。
- 宿主识别为表格。
- 历史会话和 provider 设置与其他宿主共享，不出现旧数据。

### PowerPoint

- 功能区、主入口和侧栏正常。
- 宿主识别为演示。
- 不出现“灵犀AI”、旧网站或旧仓库链接。

### PDF

- 彻底退出 WPS 后，直接双击本地测试 PDF 冷启动。
- 已接受的当前方案是无边框贴靠侧窗；它应跟随 WPS 主窗移动、缩放和关闭。
- Anthony AI 入口可点击。
- 能识别当前 PDF 路径并读取页数/文本；不弹无关文件选择器。
- 新建 PDF 会话，关闭侧窗和 WPS，再打开同一 PDF 后新历史可恢复。
- 不期待恢复已清除的旧历史。

### Provider 设置

- 新增一个测试 provider，保存后关闭设置和 WPS。
- 重开后 provider 仍存在，且 Word/Excel/PPT/PDF读取一致。
- 测试凭据不得出现在日志或最终报告中；验收后可删除测试 provider。

任何一项失败都进入“复现 → 日志 → 隔离根因 → 最小修复 → 重测”循环，不得通过反复重装掩盖。

## 9. 后台 CPU / 内存验收

重点进程：命令行位于 `.anthony-ai` 的 `node.exe`、watchdog PowerShell、任务 `AnthonyAI`。

分别观察三种状态，每种 5 分钟：

1. WPS 打开、Anthony AI 面板关闭且空闲。
2. WPS 打开、Anthony AI 面板打开但不操作。
3. 完全退出 WPS。

记录每 5 秒的进程 PID、CPU 累计时间、WorkingSet、命令行，并计算 5 分钟均值、峰值和内存趋势。验收要求：

- 面板空闲时 `proxy-server.js` 不得再次持续占用约 10%–29% CPU。
- 单个产品 Node 在空闲观察窗的平均 CPU 建议低于单核 3%，无持续锯齿式高占用；短暂启动峰值单独解释。
- WorkingSet 不应在无操作时持续单调增长超过约 20%。
- 完全退出 WPS 后，等待 `IdleSeconds + 15 秒`（当前默认约 45 秒），产品 Node 进程必须消失；watchdog 可继续等待下次 WPS 启动。

若不满足，保存 `%USERPROFILE%\.anthony-ai\server.log` 的去敏片段和进程命令行，停止验收结论。

## 10. 注销/重启后的最终冷启动

至少注销当前 Windows 用户并重新登录一次；更推荐重启 Windows。重启前把本文件、`$WorkRoot` 和当前验收进度告诉用户，重启后让用户重新打开 Codex 并继续本节。

重新登录后验证：

- `LingxiAI` 任务、Run 值、进程和目录没有复活。
- `AnthonyAI` 计划任务 principal 是目标 SID，LastTaskResult 正常。
- 打开 Word/Excel/PPT 均可唤起 Anthony AI。
- 完全退出后直接打开测试 PDF，贴靠侧窗、路径识别和新历史正常。
- `install-complete.json` 的提交 SHA 与仓库/安装器一致。

## 11. 最终报告模板

最终回复用户时按以下结构报告，不得省略失败项：

```markdown
# Anthony AI Windows 迁移验收报告

- Windows / 架构：
- WPS 版本 / 路径：
- 目标用户 / SID / SessionId：
- 仓库 URL：
- 安装提交 SHA：
- 安装器 SHA-256：
- 安装目录：
- 内置 Node 路径 / 版本：
- 静态端口 / 代理端口：

## 清理结果
- 旧卸载项：删除了哪些，复检是否为 0
- 旧/当前任务与 Run：删除了哪些，复检是否为 0
- 旧/当前目录：删除了哪些，复检是否为 0
- WebView/PluginStorage：四宿主状态与删除键数量（只写键名/数量，不写值）
- 第三方 WPS 加载项：迁移前后节点语义是否一致

## 测试
- Windows 静态门禁：
- 定向测试：
- 完整 Node 测试：通过/失败/跳过及失败集合
- Inno 编译：
- 服务与十二条静态路由探活：

## 四宿主
- Word：
- Excel：
- PowerPoint：
- PDF 冷启动/贴靠/路径/历史：
- Provider 保存与跨宿主读取：

## 性能与重启
- 三种状态各 5 分钟 CPU/内存结果：
- WPS 关闭后 Node 是否在 45 秒内退出：
- 注销/重启后冷启动结果：

## 结论
- 是否达到“正常使用”：是 / 否
- 未解决问题与日志路径：
```

若任何必选项未完成，结论必须为“尚未通过”，并明确下一步，而不是写“基本完成”。
