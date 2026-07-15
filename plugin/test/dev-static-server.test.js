const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

function waitForJson(url, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: JSON.parse(body) });
          } catch (error) {
            if (Date.now() - startedAt >= timeoutMs) reject(error);
            else setTimeout(attempt, 100);
          }
        });
      }).on("error", (error) => {
        if (Date.now() - startedAt >= timeoutMs) reject(error);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("dev static server can serve from an explicit snapshot root with stable file metadata", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lingxi-dev-static-"));
  const filePath = path.join(tmpRoot, "index.html");
  fs.writeFileSync(filePath, "<!doctype html><title>snapshot-root</title>\n", "utf8");

  const port = 43189;
  const child = spawn(process.execPath, ["tools/dev-static-server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      STATIC_PORT: String(port),
      STATIC_PORT_LADDER_SIZE: "0",
      LINGXI_DEV_ROOT: tmpRoot,
      LINGXI_DEV_PATH_PREFIX: "/__test_snapshot",
      LINGXI_PROXY_PORT: "43290"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await t.test("healthz reports the explicit root", async () => {
    const health = await waitForJson(`http://127.0.0.1:${port}/__test_snapshot/healthz`);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.root, tmpRoot);
    assert.equal(health.body.devPathPrefix, "/__test_snapshot");
    assert.equal(health.body.proxyPort, 43290);
  });

  await t.test("index.html comes from that root and includes Last-Modified", async () => {
    const res = await httpRequest({
      host: "127.0.0.1",
      port,
      path: "/__test_snapshot/index.html",
      method: "HEAD"
    });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["last-modified"] || ""), /\w{3},/);

    const bodyRes = await httpRequest({
      host: "127.0.0.1",
      port,
      path: "/__test_snapshot/index.html",
      method: "GET"
    });
    assert.equal(bodyRes.statusCode, 200);
    assert.match(bodyRes.body, /window\.__LINGXI_PROXY_PORT__=43290/);
    assert.match(bodyRes.body, /<title>snapshot-root<\/title>/);
  });

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  if (stderr) {
    assert.doesNotMatch(stderr, /启动失败|EADDRINUSE/);
  }
});
