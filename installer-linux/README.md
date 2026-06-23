# 灵犀AI Linux Installer

产出三份，覆盖国产 + 主流 Linux 发行版：

| 包格式 | 文件名 | 适用 |
|---|---|---|
| `.tar.gz` | `lingxi-ai-<v>-linux-<arch>.tar.gz` | **所有发行版通用**(含 Loongnix / 申威等) |
| `.deb` | `lingxi-ai_<v>_<arch>.deb` | Ubuntu / Debian / **Deepin** / **统信 UOS** / **银河麒麟桌面版** / **openKylin** |
| `.rpm` | `lingxi-ai-<v>-1.<arch>.rpm` | Fedora / RHEL / CentOS Stream / **openEuler** / **Anolis OS** / **银河麒麟服务器版** / **中标麒麟 NeoKylin** / **统信 UOS 服务器版** |

跟 Windows 端 Inno Setup、Mac 端 pkg+dmg 流程对齐：发布工件是单文件，用户态做 `publish.xml` + 后台服务，宿主侧 `systemd --user` 单元保活。

## 发行版兼容性矩阵

✅ = 已验证 / 设计上覆盖,❓ = 应该可用未实测,❌ = 不支持(原因见末尾)

| 发行版 | x86_64 | aarch64 (鲲鹏/飞腾) | loongarch64 (龙芯) | 推荐包 |
|---|:--:|:--:|:--:|---|
| **银河麒麟 Kylin V10 桌面版** | ✅ | ✅ | ❓ | `.deb` |
| **银河麒麟 Kylin V10 服务器版** | ✅ | ✅ | ❓ | `.rpm` |
| **中标麒麟 NeoKylin V7** | ✅ | ❓ | — | `.rpm` |
| **统信 UOS 桌面版** | ✅ | ✅ | ❓ | `.deb` |
| **统信 UOS 服务器版** | ✅ | ✅ | — | `.rpm` |
| **Deepin 20+** | ✅ | ✅ | — | `.deb` |
| **openKylin** | ✅ | ✅ | — | `.deb` |
| **openEuler 22.03+** | ✅ | ✅ | ❓ | `.rpm` |
| **Anolis OS 8+ / 龙蜥** | ✅ | ✅ | — | `.rpm` |
| **Ubuntu 20.04+** | ✅ | ✅ | — | `.deb` |
| **Debian 11+** | ✅ | ✅ | — | `.deb` |
| **Fedora 36+ / RHEL 9 / CentOS Stream 9** | ✅ | ✅ | — | `.rpm` |
| **Loongnix / Loongarch 系统** | — | — | ❓ | `.tar.gz`(需自备 node) |
| **申威 sw_64 系统** | — | — | — | `.tar.gz`(需自备 node) |

## 文件清单

```
installer-linux/
├── build.sh                   主构建脚本(tar.gz + .deb + .rpm)
├── install.sh                 tar.gz 解压后的安装入口
├── uninstall.sh               tar.gz 解压后的卸载入口
├── debian/
│   ├── postinst               .deb 装完触发
│   └── prerm                  .deb 删前触发
└── rpm/
    └── lingxi-ai.spec         RPM 规格(含 %post / %preun)
```

真正的安装/卸载逻辑(被三种包共用)：

- [plugin/tools/post-install-linux.sh](../plugin/tools/post-install-linux.sh) —— 用户上下文：挑 Node、生成变体、写 publish.xml、写 systemd `--user` 单元并 enable+start
- [plugin/tools/pre-uninstall-linux.sh](../plugin/tools/pre-uninstall-linux.sh) —— 用户上下文：stop+disable 单元、杀残留 node、删 publish.xml、删 `~/.lingxi-ai`

## 怎么打包

**前提**：Linux 主机 / macOS / WSL 均可（脚本只依赖 `bash`、`tar`，`rsync` 可选）。

| 产物 | 额外工具 | 安装 |
|---|---|---|
| `.tar.gz` | 无 | — |
| `.deb` | `dpkg-deb` | Ubuntu/Debian 自带；Mac `brew install dpkg`；Fedora `sudo dnf install dpkg` |
| `.rpm` | `rpmbuild` | Fedora 自带；Ubuntu `sudo apt install rpm`；Mac `brew install rpm` |

```bash
cd installer-linux

bash build.sh                              # 默认 x64,有什么工具就产什么(tar+deb+rpm)
bash build.sh --arch arm64                 # arm64 (鲲鹏/飞腾)
bash build.sh --format tar                 # 只要 tar.gz
bash build.sh --format deb,rpm             # 只要 deb 和 rpm
bash build.sh --version 1.3.0

# 国产 CPU(没有 Node.js 官方预编译):
bash build.sh --arch loongarch64           # 龙芯 - 自动跳过内置 node,装时用系统 node
bash build.sh --arch sw_64                 # 申威
bash build.sh --arch mips64el              # 旧龙芯
```

第一次跑会自动调 `node ../plugin/tools/bundle-node.js` 下载对应架构的 Node 运行时（x64/arm64 ~30MB，进包后压到 ~12MB）。已下过就跳过。

## 安装时发生了什么

### .deb 路径(Ubuntu/Debian/Deepin/UOS/银河麒麟桌面版/openKylin)

```bash
sudo apt install ./lingxi-ai_<v>_amd64.deb
# 或: sudo dpkg -i ... && sudo apt -f install
```

`debian/postinst` 在 root 上下文跑，通过 `SUDO_USER` / `logname` / `who` / 兜底扫 `/home/*` 找出真实登录用户，`sudo -u` 切过去调 `post-install-linux.sh`。

### .rpm 路径(openEuler/Anolis/银河麒麟服务器/中标麒麟/Fedora/RHEL/UOS Server)

```bash
sudo dnf install ./lingxi-ai-<v>-1.x86_64.rpm
# 老 yum 也行: sudo yum install ./lingxi-ai-...rpm
# 银河麒麟服务器/中标麒麟也是 dnf/yum
```

`rpm/lingxi-ai.spec` 里 `%post` scriptlet 走和 `debian/postinst` 一样的逻辑——找真实用户，`sudo -u` 调 `post-install-linux.sh`。

### .tar.gz 路径(任意发行版,包括龙芯/申威)

```bash
tar -xzf lingxi-ai-<v>-linux-x64.tar.gz
cd lingxi-ai-<v>

bash install.sh                # 装到 ~/.local/share/lingxi-ai(无需 sudo,推荐)
sudo bash install.sh           # 装到 /opt/lingxi-ai(系统级,多用户共享)
bash install.sh --prefix /custom/dir
```

### post-install-linux.sh 干的活(三种包共用)

1. **架构识别**：`uname -m` → 选 `runtime/node-linux-x64` / `node-linux-arm64`；国产 CPU 自动退到系统 PATH 上的 node
2. **发行版指纹**：解析 `/etc/os-release` 写日志，方便用户报问题时一眼看出环境
3. **停老服务**(升级)：`systemctl --user stop` + `pkill node`
4. **生成变体**：`build-variants.js` → `~/.lingxi-ai/plugin-{wps,et,wpp,pdf}`
5. **拷服务脚本** → `~/.lingxi-ai/tools/`
6. **写 publish.xml** 到所有已知 WPS Linux 配置路径(写多了不会出错)：

   | 路径 | 适用 |
   |---|---|
   | `~/.config/Kingsoft/Office6/jsaddons/` | 主流官方包 (WPS for Linux 11.x deb/rpm) |
   | `~/.config/wps-office/jsaddons/` | 部分国产分发(UOS/麒麟) |
   | `~/.config/wps/jsaddons/` | 老版 |
   | `~/.kingsoft/office6/jsaddons/` | 早期 WPS for Linux |
   | `~/.kingsoft/Office6/jsaddons/` | 大写变体 |
   | `~/.linglong/com.wps.office/data/.config/Kingsoft/Office6/jsaddons/` | **UOS 玲珑(linglong)沙箱** |
   | `~/snap/wps-office/current/.config/...` | snap |
   | `~/.var/app/com.wps.Office/config/...` | flatpak |

7. **写 `~/.config/systemd/user/lingxi-ai.service`**，`enable + restart`；`loginctl enable-linger` 让用户没登录时也保活。systemd 不可用(老 CentOS/容器)退到 `~/.config/autostart/lingxi-ai.desktop` + `nohup`。
8. **探活**：3889 端口 + `curl` 各宿主 `manifest.json`

日志：`~/.lingxi-ai/install.log`

## 卸载

| 装法 | 卸法 |
|---|---|
| `.deb` | `sudo apt remove lingxi-ai` 或 `sudo dpkg -r lingxi-ai` |
| `.rpm` | `sudo dnf remove lingxi-ai` 或 `sudo rpm -e lingxi-ai` |
| `.tar.gz` 装到 `~/.local/share/lingxi-ai` | `bash ~/.local/share/lingxi-ai/uninstall.sh` |
| `.tar.gz` 装到 `/opt/lingxi-ai` | `sudo bash /opt/lingxi-ai/uninstall.sh` |

三条路径都会执行：
- `systemctl --user stop + disable lingxi-ai.service`
- `pkill -9 -f serve-permanent` / `pkill -9 -f proxy-server`
- 删 `~/.config/systemd/user/lingxi-ai.service` + `~/.config/autostart/lingxi-ai.desktop`
- 删上面 8 个路径下所有 `publish.xml`
- 删 `~/.lingxi-ai/`

## 本地测试

```bash
# === 装 ===
# Ubuntu / Deepin / UOS / 银河麒麟桌面版:
sudo apt install ./dist/lingxi-ai_1.3.0_amd64.deb

# openEuler / 银河麒麟服务器 / 中标麒麟 / Fedora:
sudo dnf install ./dist/lingxi-ai-1.3.0-1.x86_64.rpm

# 任意发行版 / 龙芯 / 申威:
tar -xzf dist/lingxi-ai-1.3.0-linux-x64.tar.gz
cd lingxi-ai-1.3.0 && bash install.sh

# === 验 ===
ls ~/.lingxi-ai/                                  # plugin-wps / plugin-et / plugin-wpp / plugin-pdf / tools / server.log
systemctl --user status lingxi-ai                 # active (running)
curl -s http://127.0.0.1:3889/wps/manifest.json   # 200
ls ~/.config/Kingsoft/Office6/jsaddons/publish.xml

# === 看日志 ===
cat ~/.lingxi-ai/install.log
journalctl --user -u lingxi-ai -n 50

# === 卸 ===
sudo apt remove lingxi-ai          # 或 sudo dnf remove lingxi-ai
```

## 已知坑

### 国产发行版相关

1. **银河麒麟 V10 早期版本 glibc 太老**
   - 早期 V10 基于 Ubuntu 18.04,glibc 2.27;Node 22 LTS 要求 glibc ≥ 2.28
   - `post-install-linux.sh` 会自动检测:内置 node 跑不起来时退到系统 node
   - 解决方案:升级到 V10 SP1 之后(glibc 2.31+),或者系统装 Node 18 LTS(`sudo apt install nodejs`)

2. **国产 WPS 没有「灵犀AI」标签**
   - 这是 jsaddons 路径找不对,99% 是因为版本太旧或路径在我们的 `PUBLISH_DIRS` 名单外
   - 排查:
     ```bash
     # 看 WPS 实际读哪条路径
     find ~/.config ~/.kingsoft ~/.linglong -name 'publish.xml' 2>/dev/null
     # 看灵犀AI 的安装日志
     cat ~/.lingxi-ai/install.log
     ```
   - 把缺的路径加进 `plugin/tools/post-install-linux.sh` 里的 `PUBLISH_DIRS` 数组

3. **龙芯 / 申威 / RISC-V**
   - Node.js 官方 dist 不出 loongarch64/sw_64/mips64el 预编译
   - 用 `--arch loongarch64`(或 sw_64/mips64el) 打包,不带内置 node
   - 用户机器先装系统 node:
     - Loongnix: `sudo apt install nodejs`(Loongnix 软件源有)
     - 龙芯麒麟/UOS: 同上
     - 申威: 需要从源码编译,或者用 OEM 提供的 node 包
   - 内置 node 缺失 + 系统也没 node → `post-install-linux.sh` 报错退出,日志里有完整指引

4. **UOS 玲珑(linglong)沙箱里的 WPS**
   - 沙箱限制:本地后台服务(127.0.0.1:3889)在沙箱内可能访问不了宿主
   - 当前方案写 `publish.xml` 到沙箱目录,但 WPS 沙箱内能否 fetch `http://127.0.0.1:3889` 取决于 linglong 网络隔离配置
   - 实测有问题时,改用沙箱外装的 WPS 版本

5. **银河麒麟 V10 高安全配置**
   - 内核 KCAS 模块开 `mandatory` 模式时,普通用户可能没权限写 `~/.config/systemd/user/`
   - 表现:`systemctl --user daemon-reload` 失败,服务起不来
   - 解决:让管理员临时降级 KCAS,或者用 `--keep-files` 装绿色包跳过 systemd,改用 autostart `.desktop`(脚本会自动退到这条路径)

### 通用坑

6. **CI/无人值守环境 .deb/.rpm 找不到真实用户**
   - `apt install` 在容器里、纯 SSH 装机时 `SUDO_USER` 可能空
   - 脚本会兜底扫 `/home/*`;还失败就打印命令让用户自己跑 `post-install-linux.sh`
   - 桌面发行版上几乎一定有 `SUDO_USER`,问题不大

7. **systemd `--user` 在某些发行版默认没起**
   - CentOS 7 / 老 RHEL / 容器内常见
   - 脚本会退到 XDG autostart `.desktop`,用户下次登录 GUI 时拉起来
   - 服务器也能用 `loginctl enable-linger` 后手动 `systemctl --user daemon-reload`

8. **arm64 包要在 arm64 机器上 / 交叉打包**
   - `build.sh --arch arm64` 只是改了产物名和拷的 node 运行时
   - `dpkg-deb` / `rpmbuild` 自身是脚本驱动的,跨架构打包没问题
   - 但**测试**必须真到 arm64 机器上(鲲鹏 920 / 飞腾 D2000 / 海光等)

9. **WPS for Linux 个人版长期不维护**
   - 官方分发的最新 deb 是 11.1.0.11719 (2023)
   - 国产专业版会持续更新,jsaddons 协议偶尔有差异
   - 新版回归出问题先看 `~/.lingxi-ai/install.log`,再看 `~/.config/Kingsoft/Office6/wpscloudsvr.log`
