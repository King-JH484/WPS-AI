# upload-oss

把灵犀AI 安装包（Windows `.exe` / macOS `.pkg` / `.dmg`）上传到阿里云 OSS，
并自动改写下载站 [site/utils/release.ts](../site/utils/release.ts) 里的下载链接。

## 一次性配置

```bash
cd upload-oss
npm install
cp oss.config.example.js oss.config.js
# 编辑 oss.config.js，填入 region / accessKey / bucket。
# oss.config.js 已被 .gitignore，不会提交。
```

建议在 RAM 控制台单建一个**仅有目标 Bucket 写权限**的子账号，不要用主账号 AK。

## 用法

```bash
# 默认：自动从 installer/dist/ 和 installer-mac/dist/ 扫描产物
npm run upload

# 只想看会上传什么、会改什么，不真的传
npm run upload:dry

# 上传，但不动 site/utils/release.ts
npm run upload:no-site

# 显式指定文件
node index.js ../installer/dist/lingxi-ai-1.3.0-setup.exe ../installer-mac/dist/lingxi-ai-1.3.0.pkg

# 覆盖版本号
node index.js -v 1.3.1
```

## 行为

1. **扫描产物**
   - Windows：`installer/dist/*-setup.exe`
   - macOS：`installer-mac/dist/*.{pkg,dmg}`（`.pkg` 优先作为主下载）
2. **分片上传到 OSS**
   - Key 规则：`{pathPrefix}/{version}/{filename}`
   - 默认 1 MB 分片、4 并发，大文件无问题
   - 上传时附 `Cache-Control` + `Content-Disposition: attachment` 头，
     让浏览器把 .exe / .pkg / .dmg 当附件下载
3. **改写下载站链接**
   - 修改 [site/utils/release.ts](../site/utils/release.ts) 中由标记
     `// region OSS_URLS_BEGIN` … `// endregion OSS_URLS_END` 包裹的区块
   - `DOWNLOADS.{windows,mac}.url` 自动从该区块取值，OSS 为空时回退到 GitHub Releases

## 配置项一览

见 [oss.config.example.js](oss.config.example.js)。关键字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `region` | ✅ | OSS 区域，如 `oss-cn-hangzhou` |
| `accessKeyId` / `accessKeySecret` | ✅ | RAM 子账号 AK |
| `bucket` | ✅ | 目标桶 |
| `endpoint` | ⭕ | 走内网 / 自定义域名时填 |
| `cdnBaseUrl` | ⭕ | 自定义 CDN 域名，写回 site 的 URL 会用它 |
| `pathPrefix` | ⭕ | 桶内路径前缀，默认 `releases` |
| `multipart` | ⭕ | `{ partSize, parallel }` |
| `headers` | ⭕ | 上传时附加 HTTP 头 |

## 文件结构

```
upload-oss/
├── package.json              # 仅依赖 ali-oss
├── oss.config.example.js     # 配置模板（进 git）
├── oss.config.js             # 真实配置（不进 git）
├── index.js                  # CLI 入口
├── lib/
│   ├── client.js             # ali-oss 封装：分片上传 + 公网 URL 推算
│   ├── discover.js           # 扫描 installer*/dist 找产物
│   └── update-site.js        # 改写 site/utils/release.ts 标记区块
└── README.md
```

## 与 GitHub Releases 共存

`release.ts` 中 `DOWNLOADS` 优先用 `OSS_URLS`，为空才回退 `RELEASE_PAGE`。
所以即便没上 OSS，下载站也能正常跑（指 GitHub Releases）。
