// 复制本文件为 oss.config.js 后填入真实凭据。
// oss.config.js 已在 .gitignore 中，不会提交。
//
// AccessKey 申请：https://ram.console.aliyun.com/manage/ak
// 建议建一个仅有目标 Bucket 写权限的 RAM 子账号，不要用主账号 AK。

module.exports = {
  // 桶所在地域。常见值：
  //   oss-cn-hangzhou / oss-cn-shanghai / oss-cn-beijing / oss-cn-shenzhen
  //   oss-cn-hongkong / oss-ap-southeast-1
  region: 'oss-cn-hangzhou',

  // RAM 子账号 AccessKey
  accessKeyId: 'YOUR_ACCESS_KEY_ID',
  accessKeySecret: 'YOUR_ACCESS_KEY_SECRET',

  // 桶名
  bucket: 'your-bucket-name',

  // （可选）自定义 endpoint。绑了自定义域名 / 走 internal 网络时填。
  // 留空走 region 默认 (https://<bucket>.<region>.aliyuncs.com)。
  endpoint: '',

  // （可选）CDN / 自定义下载域名。例如：'https://github.com/King-JH484/WPS-AI'
  // 填了之后，写回 site 的链接会用这个域名前缀，不暴露 OSS 原始 URL。
  // 留空则用 OSS 默认 URL。
  cdnBaseUrl: '',

  // 上传到桶内的路径前缀，最终 key = `${pathPrefix}/${version}/${filename}`
  pathPrefix: 'releases',

  // （可选）应用内热更新 plugin.zip 的路径前缀。
  // 默认取 pathPrefix 的父目录 + '/plugin'：
  //   pathPrefix='wps-ai/releases' → pluginPathPrefix='wps-ai/plugin'
  //   pathPrefix='releases'        → pluginPathPrefix='plugin'
  // 显式指定可完全覆盖：
  // pluginPathPrefix: 'wps-ai/plugin',

  // （可选）检查更新清单 manifest.json 的完整 key（桶内绝对路径）。
  // 默认取 pathPrefix 的父目录 + '/manifest.json'。
  // 必须跟 plugin/js/updater.js 里 DEFAULT_MANIFEST_URL 一致。
  // manifestKey: 'wps-ai/manifest.json',

  // （可选）Chromium 按需下载配置。插件抓取素材图片时会优先使用本机 Chrome/Chromium/Edge；
  // 本机没有可用浏览器时，再按 manifest.chromium 下载对应平台的 runtime。
  // runtime 建议单独上传到 OSS/CDN，不放进 plugin.zip。
  // chromium: {
  //   version: 'chrome-for-testing-150.0.7871.46',
  //   platforms: {
  //     'darwin-arm64': {
  //       url: 'https://download.example.com/wps-ai/chromium/chrome-for-testing-150.0.7871.46/darwin-arm64.zip',
  //       sha256: '64位sha256',
  //       executablePath: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  //     },
  //     'darwin-x64': {
  //       url: 'https://download.example.com/wps-ai/chromium/chrome-for-testing-150.0.7871.46/darwin-x64.zip',
  //       sha256: '64位sha256',
  //       executablePath: 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  //     },
  //     'win-x64': {
  //       url: 'https://download.example.com/wps-ai/chromium/chrome-for-testing-150.0.7871.46/win-x64.zip',
  //       sha256: '64位sha256',
  //       executablePath: 'chrome-win64/chrome.exe'
  //     },
  //     'linux-x64': {
  //       url: 'https://download.example.com/wps-ai/chromium/chrome-for-testing-150.0.7871.46/linux-x64.zip',
  //       sha256: '64位sha256',
  //       executablePath: 'chrome-linux64/chrome'
  //     }
  //   }
  // },

  // （可选）分片上传参数。大文件建议保持默认。
  multipart: {
    partSize: 1024 * 1024,   // 1 MB
    parallel: 4
  },

  // （可选）上传时给对象设置 HTTP headers。
  // 比如让浏览器把 .exe / .pkg / .dmg 当附件下载而不是直接打开。
  headers: {
    'Cache-Control': 'public, max-age=86400',
    'Content-Disposition': 'attachment'
  },

  // （可选）npm run upsite 用的下载页静态站桶。可以跟主桶不同地域/不同 AK。
  // 留空表示不启用 upsite。
  site: {
    region: 'oss-cn-shanghai',
    bucket: 'anthony-ai-site',
    // accessKeyId / accessKeySecret 不写就复用顶层（同账号情况下方便）
    // accessKeyId: 'YOUR_SITE_AK',
    // accessKeySecret: 'YOUR_SITE_SK',

    // 本地静态产物目录，默认 site/.output/public/（nuxt generate 的输出位置）
    // distDir: '../site/.output/public',

    // 桶内路径前缀，留空 = 推到根目录（index.html 直接放在桶根）
    pathPrefix: ''
  }
}
