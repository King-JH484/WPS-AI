# 品牌改名与旧品牌清理指南

这份文档的目标：**任何人（包括 AI 助手）拿到这个仓库，只读这一篇，就能把品牌整体替换掉，并且把旧品牌痕迹清理干净，不留坑。**

本项目 fork 自「灵犀AI」（`lingxi-ai`）。仓库里当前的品牌已经整体替换过一轮，但**旧品牌的字面量被刻意保留了一部分**——它们是升级兼容逻辑，不是漏网之鱼。下面第 3 节专门讲这个。

文中约定三个占位符，代表**当前品牌**的三种形态：

| 占位符 | 含义 | 用在哪 |
|---|---|---|
| `<UPPER>` | 全大写下划线 | 环境变量 `<UPPER>_STATIC_PORT`、`<UPPER>_PROXY_PORT` |
| `<Pascal>` | 显示名 / 帕斯卡 | UI 文案、C# 类名、Windows 安装目录、注册表键名 |
| `<lower>` | 全小写连字符 | 文件路径 `~/.<lower>-ai/`、服务名 `com.<lower>-ai.server`、插件 ID `<lower>-ai-wps` |

---

## 1. 直接怎么做

```bash
node dev/rebrand.js "新品牌"           # 预演，只打印会改什么
node dev/rebrand.js "新品牌" --apply   # 落盘
```

`dev/rebrand.js` 已经把下面所有规则和坑都编码进去了，**优先用它，不要手写 sed**。手写 sed 会踩第 3、4 节的坑。

脚本做四件事：

1. 从 `plugin/js/updater.js` 第一行读出**当前**品牌，所以不需要在任何地方写死旧名；
2. 三形态大小写保形替换（第 2 节）；
3. 按原编码写回（第 4 节），GBK 批处理走 `iconv`；
4. 收尾断言旧品牌字面量数量前后一致，对不上就 `git checkout` 整体回滚（第 3 节）。

辅助命令：

```bash
node dev/rebrand.js --list-encodings   # 核对 .bat 的实际编码和脚本内清单是否一致
```

### 改名后必须同步维护的一处

`plugin/js/updater.js` 第一行是**品牌名的唯一真源**：

```js
// <Pascal> AI 插件热更新
```

改名脚本自己也靠这行定位当前品牌。如果哪天重构掉了这个注释，`dev/rebrand.js` 会直接报错退出——那时候要么恢复这行，要么改脚本的 `currentBrand()`。别让它静默失效。

---

## 2. 三种形态的派生规则

给定显示名 `D`（ASCII 字母数字，允许空格）：

```js
lower  = D.toLowerCase().replace(/\s+/g, "-")
Pascal = D.replace(/\s+/g, "")
UPPER  = lower.toUpperCase().replace(/-/g, "_")
```

替换时**三种形态分别做、全部大小写敏感、顺序固定 `UPPER` → `Pascal` → `lower`**。顺序固定是为了让结果可复现；因为三种形态大小写互不相同，大小写敏感替换之间不会互相吃字符。

一次性全局 `sed -i 's/old/new/gi'` 是错的：忽略大小写会把 `<UPPER>_STATIC_PORT` 改成小写形态，环境变量当场失效。

**新品牌的取值限制**（脚本会校验）：只能 ASCII 字母数字加空格、字母开头。因为它要落进环境变量名、macOS LaunchAgent 的 `Label`、Windows 注册表键名和 C# 标识符，中文和符号在这些地方过不去。

---

## 3. 受保护字面量：旧品牌 `lingxi` 系列**绝不能**扫掉

这是整个改名里最容易出事的一点。

仓库里还有约 120 处 `lingxi` / `Lingxi` / `LINGXI` / `LingxiAI` / `灵犀AI` 字面量。**它们全部是刻意保留的历史事实**，服务于同一个目的：让从旧版升级上来的机器能被正确清理。删掉它们，升级用户会遇到这些症状：

- 卸载完了 3889 / 3890 端口还被占着；
- 重启后又冒出一个后台进程；
- WPS 里出现两个插件页签，或者页签在但点了没反应。

根因：**旧版的后台服务是被系统「注册」过的，不是普通进程。**

| 平台 | 旧版注册方式 | 只 kill 进程的后果 |
|---|---|---|
| macOS | LaunchAgent `com.lingxi-ai.server`，带 `KeepAlive=true` | launchd 立刻重拉，回来抢 3889/3890 |
| Linux | systemd `--user` 单元 `lingxi-ai.service`，带 `Restart=always` | systemd 立刻重拉 |
| Windows | `HKCU\...\Run` 键 `LingxiAI` + 计划任务 `LingxiAI` | 下次登录回来 |

所以必须**注销注册**，而不只是杀进程。这就是为什么旧品牌字面量同时出现在**卸载**脚本和**安装**脚本里——一个只跑安装程序的升级用户，永远不会执行卸载脚本。

### 3.1 双名匹配（新旧两个名字都要匹配的地方）

这几处在进程名 / 启动器可执行文件名上同时列了新旧两个名字，用来兜住残留进程：

| 文件 | 行 | 内容 |
|---|---|---|
| `plugin/tools/proxy-server.js` | ~134 | 进程友好名映射，`lingxi-launcher` 与 `<lower>-launcher` |
| `plugin/tools/proxy-server.js` | ~142 | PowerShell `Win32_Process` 过滤，两个 launcher exe 都列 |
| `plugin/tools/cleanup-install-dir.ps1` | ~23 | `@('lingxi-launcher.exe', '<lower>-launcher.exe')` |
| `plugin/tools/post-install-windows.bat` | ~166 | 删遗留的 `lingxi-launcher.exe` |
| `plugin/tools/stop-<lower>-processes.ps1` | ~15, ~35 | 进程名清单含旧 launcher |

### 3.2 旧品牌清理块（`LEGACY_*`）

每个安装 / 卸载脚本里都有一段带 `LEGACY_` 前缀的变量或注释块。清单见第 6 节。

### 3.3 断言

`dev/rebrand.js` 在写盘后统计全仓库 `/lingxi/gi` 的出现次数，与改名前对比。**不相等就整体回滚并退出。** 如果你手工改名，请至少手动核对一次：

```bash
grep -rniE "lingxi" --exclude-dir=node_modules --exclude-dir=.git . | wc -l
```

改名前后这个数字必须一模一样。

---

## 4. 编码与 shell 的两个坑

### 4.1 GBK 与 UTF-8 批处理

Windows 的 `cmd.exe` 在中文环境下默认 GBK 代码页。以下历史脚本仍保持 GBK：

```
plugin/install-windows.bat
plugin/start-et.bat
plugin/start-wpp.bat
plugin/start-wps.bat
```

以下安装/卸载脚本统一为 UTF-8，并在开头显式执行 `chcp 65001`；这样可由 macOS/Linux 上的维护工具安全修改，不会发生 GBK 往返损坏：

```
installer/build.bat
plugin/install-permanent-windows.bat
plugin/uninstall-permanent-windows.bat
plugin/tools/post-install-windows.bat
plugin/tools/pre-uninstall-windows.bat
```

`plugin/runtime/node-win-x64/*.bat` 是 Node 官方发行版自带的，与本项目品牌无关，`dev/rebrand.js` 整个 `plugin/runtime/` 目录都排除。

处理管线（`dev/rebrand.js` 里已实现）：

```js
const text = new TextDecoder("gbk").decode(fs.readFileSync(f));
// ...替换...
fs.writeFileSync(tmp, out, "utf8");
const gbk = execFileSync("iconv", ["-f", "UTF-8", "-t", "GBK", tmp]);
fs.writeFileSync(f, gbk);
```

所有 `.bat` 都是 **CRLF** 行尾。上面这条管线不碰行尾，安全。改完可以用 `TextDecoder("gbk", {fatal: true})` 重新解码验证一遍。

在没有 `iconv` 的 Windows 上，请在 WSL 或 Git Bash 里跑改名脚本。

### 4.2 `>nul` 会被某些 shell 层悄悄改写成 `>/dev/null`

这个坑很隐蔽，值得单独记一笔。

在某些工具链 / agent 的 bash 封装层里，命令字符串中出现的字面量 `>nul` 会被**自动改写**成 `>/dev/null`——**包括写在 JS 字符串里的**。也就是说：

```bash
node -e 'const a = "reg query ... >nul 2>&1"; ...'
#                                    ^^^^ 到了 node 手里已经变成 >/dev/null
```

后果是：你以为在匹配 `>nul` 的锚点，实际匹配的是 `>/dev/null`，于是得到一个**假的**「锚点未命中」，或者更糟——把 `>/dev/null` 写进了 Windows 批处理。

**规则：**

1. 修改 `.bat` 文件时，把补丁**写成脚本文件**再执行（`node patch.js`），**不要用 `node -e`**；
2. 在脚本里需要构造这个重定向时，拆开写，别让它以字面量出现：
   ```js
   const NUL = "n" + "ul";
   const line = 'schtasks /Query /TN "LingxiAI" >' + NUL + " 2>&1";
   ```

`dev/rebrand.js` 是文件形式的脚本，不受影响。

---

## 5. 仓库结构：源码目录 vs 安装产物

**改名只改仓库。安装目录必须重新生成，不要去 `sed` 它。**

```
仓库                              安装后（用户机器）
plugin/                    ──►    ~/.<lower>-ai/plugin-wps/
  （唯一一份源码）                 ~/.<lower>-ai/plugin-et/
                                  ~/.<lower>-ai/plugin-wpp/
                                  ~/.<lower>-ai/plugin-pdf/
```

四份 `plugin-*` 是 `plugin/tools/build-variants.js` 生成的**宿主变体**，不是拷贝：

```bash
cd plugin
node tools/build-variants.js --out "$HOME/.<lower>-ai" --port 3889
```

`build-variants.js` **会跳过**下面三个文件，它们由安装脚本单独拷到 `~/.<lower>-ai/tools/`：

```
plugin/tools/serve-permanent.js
plugin/tools/proxy-server.js
plugin/tools/pick-node.js       ← serve-permanent.js 运行时 require 它，漏拷服务起不来
```

服务端口：

| 端口 | 进程 | 健康检查 |
|---|---|---|
| 3889 | 静态服务 `serve-permanent.js`，提供 `/wps/` `/et/` `/wpp/` `/pdf/` | `curl 127.0.0.1:3889/health` |
| 3890 | 代理 `proxy-server.js` | 路由叫 **`/healthz`**（不是 `/health`），`curl 127.0.0.1:3890/healthz` 返回服务签名+实际端口+pid |

WPS 侧的注册在 `publish.xml`——**这是 WPS 所有 JS 加载项共用的清单文件**，里面可能有别家插件的 `<jspluginonline>` 条目。所有安装 / 卸载脚本都必须**合并写入**（保留别家条目、只增删自己的 4 条），不能整体覆盖或整体删除。

---

## 6. 旧品牌痕迹清理清单

下面是各平台**已经实现**的清理内容，改名时这些逻辑要原样保留。

### macOS

| 脚本 | 上下文 | 清理内容 |
|---|---|---|
| `plugin/tools/post-install-mac.sh` | 用户 | 注销 `com.lingxi-ai.server` LaunchAgent（`bootout` + `unload` + `remove` + 删 plist）、`pkill -f "\.lingxi-ai/"` |
| `plugin/install-permanent-mac.sh` | 用户 | 同上（手动安装路径） |
| `plugin/tools/pre-uninstall-mac.sh` | 用户 | 上述 + 删 `~/.lingxi-ai`、`~/Library/Logs/lingxi-ai` + `publish.xml` 摘除 `lingxi-ai-*` 条目 |
| `plugin/uninstall-permanent-mac.sh` | 用户 | 同上，另打印 `sudo rm -rf` 提示 |
| `installer-mac/uninstall-all.sh` | **root** | 上述全部 + 删 `/Library/Application Support/LingxiAI`、`/Applications/灵犀AI 卸载.app`、`pkgutil --forget com.lingxi-ai.installer` |

需要管理员权限的（`/Library/Application Support/LingxiAI`、`pkgutil --forget`）**只有** `installer-mac/uninstall-all.sh` 能做；用户态脚本打印 `sudo` 提示而不是静默失败。

### Linux

| 脚本 | 清理内容 |
|---|---|
| `plugin/tools/post-install-linux.sh` | `systemctl --user stop/disable lingxi-ai.service`、删单元与 autostart、`daemon-reload`、`pkill -f "lingxi-ai/"` |
| `plugin/tools/pre-uninstall-linux.sh` | 上述 + 删 `~/.lingxi-ai`、`~/.local/share/lingxi-ai` + `publish.xml` 摘条目；`/opt/lingxi-ai` 不可写时打 `[WARN]` 提示 `sudo rm -rf`，不静默跳过 |
| `installer-linux/uninstall.sh` | PURGE 分支额外做 `apt purge lingxi-ai` / `rpm -e lingxi-ai`、删 `/opt/lingxi-ai` |

### Windows

| 脚本 | 清理内容 |
|---|---|
| `plugin/tools/post-install-windows.bat` | 删旧 Run/任务，按验证路径停进程，调用 XML DOM helper 合并四宿主条目，注册当前任务并 fail-closed 探活 |
| `plugin/tools/pre-uninstall-windows.bat` | 上述 + XML DOM helper 选择性删除两品牌条目 + 删用户状态目录 |
| `plugin/uninstall-permanent-windows.bat` | 同一安全停止/XML helper 逻辑 + 对 `%ProgramFiles%\LingxiAI` 打管理员提示 |
| `plugin/tools/clean-migrate-windows.ps1` | 固定目标用户 SID，审计/调用旧 Inno 卸载器、保护第三方 `publish.xml`、删除经验证的旧新品牌状态 |

### 删除操作的防呆

所有删除都带路径守卫，形如：

```bash
case "$ld" in "$HOME"/?*) ;; *) continue ;; esac
```

配合脚本开头已有的「`$HOME` 为空或为 `/` 直接退出」检查。**新增任何 `rm -rf` 时必须照抄这个模式**，否则 `sudo -u` 未 sanitize 环境时 `$HOME` 为空会把路径打到根级。

---

## 7. 改完之后：验证

```bash
# 1. 单元测试（注意：Node 24 下 `node --test test/` 会 MODULE_NOT_FOUND，必须展开文件列表）
cd plugin
node --test $(ls test/*.test.js | tr '\n' ' ')

# 2. 复核 diff，确认没碰 plugin/runtime/ 和 img/
git diff --stat

# 3. 旧品牌计数不变
grep -rniE "lingxi" --exclude-dir=node_modules --exclude-dir=.git . | wc -l

# 4. 历史 GBK 批处理仍可解码；UTF-8 安装脚本不含替换字符
node -e 'const fs=require("fs");for(const f of ["plugin/install-windows.bat","plugin/start-et.bat","plugin/start-wpp.bat","plugin/start-wps.bat"]){new TextDecoder("gbk",{fatal:true}).decode(fs.readFileSync(f));console.log("[OK GBK] "+f)};for(const f of ["installer/build.bat","plugin/install-permanent-windows.bat","plugin/uninstall-permanent-windows.bat","plugin/tools/post-install-windows.bat","plugin/tools/pre-uninstall-windows.bat"]){const s=fs.readFileSync(f,"utf8");if(s.includes("�"))throw Error(f);console.log("[OK UTF8] "+f)}'

# 5. 重建变体并重装服务，再探活
cd plugin && node tools/build-variants.js --out "$HOME/.<lower>-ai" --port 3889
curl -sS 127.0.0.1:3889/health
curl -sS 127.0.0.1:3890/cache/stats
```

**测试基线：`687` 个用例，`679` 通过，`7` 失败，`1` 跳过。** 这 7 个失败是既有的、与改名无关。改名后失败集合应当**逐条一致**——数量或条目变了就是改名引入的回归：

```
✖ 推理和工具调用过程之间保留可读间距
✖ taskpane.html 用户可见中文均有英文词条（或在例外清单）
✖ JS 渲染文案（模板/属性/toast/confirm）均有英文词条
✖ test/multimodal-error.test.js
✖ runWithTools normalizes empty assistant tool-call content for Ollama
✖ task planner can force spreadsheet read sequence before answering
✖ findBundledNode：仓库内能找到内置 node
```

其中第 2、3 条是 i18n 词条覆盖检查——**如果你改名后新增了中文 UI 文案，这两条的失败内容会变化**，那属于预期内，但要确认变化只发生在这两条上。最后一条要求仓库里存在 `plugin/runtime/*/node`，源码仓库不带 Node 发行版，所以恒定失败。

（`ℹ tests/pass/fail` 是汇总行，`✖` 开头的是失败用例行。）

---

## 8. 已知的不一致 / 待办

- `plugin/uninstall-permanent-mac.sh` 的第 2 步对 `publish.xml` 直接 `rm -f`，而不是像其他 5 个卸载入口那样做选择性过滤。后果：会把**别家插件**的 WPS 加载项注册一并干掉。已知，未改，避免与改名混在一个提交里。
- `~/Library/Logs/<lower>-ai/render/` 下的渲染 PNG 没有自动清理，会持续累积。
- 调试日志有一处把 UTF-8 当 latin1 写的编码问题。

---

## 9. 提交约定

品牌改名是**有意的产品变更**，要进仓库，并且**与功能修复分开提交**：

```
chore(brand): ...     改名本身
fix(...): ...         功能修复
docs(...): ...        本文档一类
```
