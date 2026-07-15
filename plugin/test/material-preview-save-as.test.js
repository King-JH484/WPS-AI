const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const appJs = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "taskpane.html"), "utf8");
const proxyJs = fs.readFileSync(path.join(root, "tools", "proxy-server.js"), "utf8");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForProxy(port, child) {
  const deadline = Date.now() + 5000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (resp.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastErr || new Error("proxy did not start");
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (e) {}
      resolve();
    }, 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch (e) { resolve(); }
  });
}

test("素材预览另存为按钮位于复制地址左侧并完成绑定", () => {
  const saveIdx = html.indexOf('id="materialPreviewSaveAsBtn"');
  const copyIdx = html.indexOf('id="materialPreviewCopyBtn"');
  assert.ok(saveIdx >= 0, "素材预览弹窗应有另存为按钮");
  assert.ok(copyIdx >= 0, "素材预览弹窗应有复制地址按钮");
  assert.ok(saveIdx < copyIdx, "另存为按钮应位于复制地址左侧");

  assert.match(appJs, /"materialPreviewSaveAsBtn"/);
  assert.match(appJs, /function savePreviewMaterialAs\(\)/);
  assert.match(appJs, /materialPreviewSaveAsBtn\?\.\addEventListener\("click", savePreviewMaterialAs\)/);
  assert.match(appJs, /getMaterialFullDataUrl\(item\)/);
  assert.match(appJs, /\/save-local-image-as/);
});

test("素材预览不再展示插入当前文档左侧的修改按钮", () => {
  assert.doesNotMatch(html, /id="materialPreviewModifyBtn"/, "预览弹窗 footer 不应再有修改按钮");
  assert.doesNotMatch(appJs, /"materialPreviewModifyBtn"/, "JS 元素映射不应再包含预览修改按钮");
  assert.doesNotMatch(appJs, /materialPreviewModifyBtn\?\.\addEventListener/, "不应再绑定预览修改按钮事件");
});

test("proxy /save-local-image-as 支持 Linux 桌面对话框和 Node 兜底写入", async (t) => {
  assert.match(proxyJs, /\/save-local-image-as/);
  assert.match(proxyJs, /zenity/);
  assert.match(proxyJs, /kdialog/);
  assert.match(proxyJs, /LINGXI_SAVE_AS_DISABLE_DIALOG/);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-save-as-"));
  t.after(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) {} });

  const proxyPort = await freePort();
  const proxyScript = path.join(root, "tools", "proxy-server.js");
  const child = spawn(process.execPath, [proxyScript], {
    cwd: root,
    env: {
      ...process.env,
      PROXY_PORT: String(proxyPort),
      PROXY_PORT_LADDER_SIZE: "1",
      LINGXI_SAVE_AS_DISABLE_DIALOG: "1",
      LINGXI_SAVE_AS_DIR: outDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => stopChild(child));

  await waitForProxy(proxyPort, child);

  const resp = await fetch(`http://127.0.0.1:${proxyPort}/save-local-image-as`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,aGVsbG8=",
      suggestedName: "测试 图片"
    })
  });
  const payload = await resp.json();

  assert.equal(resp.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(payload.cancelled, false);
  assert.equal(payload.path, path.join(outDir, "测试 图片.png"));
  assert.equal(fs.readFileSync(payload.path, "utf8"), "hello");
});
