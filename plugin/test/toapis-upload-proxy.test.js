const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const proxyServerJs = fs.readFileSync(path.join(__dirname, "..", "tools", "proxy-server.js"), "utf8");

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

test("proxy /toapis-upload-image posts file multipart to uploads/images", async (t) => {
  let upstreamRequest = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      upstreamRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("latin1")
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: { url: "https://files.toapis.com/uploads/input.png" }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const proxyPort = await freePort();
  const proxyScript = path.join(__dirname, "..", "tools", "proxy-server.js");
  const child = spawn(process.execPath, [proxyScript], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PROXY_PORT: String(proxyPort),
      PROXY_PORT_LADDER_SIZE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => stopChild(child));

  await waitForProxy(proxyPort, child);

  const resp = await fetch(`http://127.0.0.1:${proxyPort}/toapis-upload-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: "tok",
      imageBase64: Buffer.from("hello").toString("base64"),
      imageMime: "image/png"
    })
  });
  const payload = await resp.json();

  assert.equal(resp.status, 200, JSON.stringify(payload));
  assert.equal(payload.data.url, "https://files.toapis.com/uploads/input.png");
  assert.equal(upstreamRequest.method, "POST");
  assert.equal(upstreamRequest.url, "/v1/uploads/images");
  assert.equal(upstreamRequest.headers.authorization, "Bearer tok");
  assert.match(upstreamRequest.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(upstreamRequest.body, /name="purpose"\r\n\r\ngeneration/);
  assert.match(upstreamRequest.body, /name="file"; filename="image\.png"/);
  assert.match(upstreamRequest.body, /Content-Type: image\/png/);
  assert.match(upstreamRequest.body, /hello/);
});

test("proxy /forward uses HTTP/1.1 ALPN because https.request cannot parse HTTP/2 responses", () => {
  assert.match(proxyServerJs, /ALPNProtocols:\s*\[\s*"http\/1\.1"\s*\]/);
  assert.doesNotMatch(proxyServerJs, /ALPNProtocols:\s*\[\s*"h2"/);
});
