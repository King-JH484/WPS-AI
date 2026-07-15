const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

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

test("proxy /image-rtf-file embeds a local PNG as an RTF pict", async (t) => {
  const pngPath = path.join(os.tmpdir(), `lingxi-rtf-${Date.now()}.png`);
  fs.writeFileSync(
    pngPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64")
  );
  t.after(() => { try { fs.unlinkSync(pngPath); } catch (e) {} });

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

  const resp = await fetch(`http://127.0.0.1:${proxyPort}/image-rtf-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: pngPath })
  });
  const payload = await resp.json();

  assert.equal(resp.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.ok(payload.rtfPath, "rtfPath should be returned");
  const rtf = fs.readFileSync(payload.rtfPath, "utf8");
  assert.match(rtf, /^\{\\rtf1/);
  assert.match(rtf, /\\pict\\pngblip/);
  assert.match(rtf, /89504e470d0a1a0a/);
});
