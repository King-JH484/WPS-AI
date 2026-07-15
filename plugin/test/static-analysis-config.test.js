const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("static analysis scripts are available from package.json", () => {
  const pkg = JSON.parse(readText("package.json"));

  assert.equal(pkg.scripts["lint:eslint"], "eslint main.js js tools test");
  assert.equal(pkg.scripts.lint, "npm run lint:eslint");
  assert.equal(pkg.scripts["scan:semgrep"], "node tools/run-semgrep.js");
  assert.equal(pkg.scripts["scan:semgrep:ci"], "node tools/run-semgrep.js --error");
  assert.equal(pkg.scripts["check:static"], "npm run lint:eslint && npm run scan:semgrep:ci");
  assert.ok(pkg.devDependencies.eslint, "eslint should be pinned as a dev dependency");
  assert.equal(pkg.devDependencies.semgrep, undefined, "semgrep should use the official CLI, not the npm placeholder package");
});

test("semgrep runner uses official CLI entrypoints and default rulesets", () => {
  const runner = readText("tools/run-semgrep.js");

  assert.match(runner, /"semgrep"/);
  assert.match(runner, /"pysemgrep"/);
  assert.match(runner, /"python3",\s*\["-m",\s*"semgrep"/);
  assert.match(runner, /"python",\s*\["-m",\s*"semgrep"/);
  assert.match(runner, /"p\/javascript"/);
  assert.match(runner, /"p\/security-audit"/);
  assert.match(runner, /startsWith\("-"\)/);
});

test("eslint config ignores bundled and generated code", () => {
  const config = readText("eslint.config.mjs");

  for (const pattern of [
    "js/vendor/**",
    "js/addon-SDK-*.js",
    "runtime/**",
    "node_modules/**",
    "tools/.gen/**"
  ]) {
    assert.match(config, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(config, /wps:\s*"readonly"/);
  assert.match(config, /Application:\s*"readonly"/);
  assert.match(config, /sourceType:\s*"script"/);
});

test("semgrep ignores bundled, generated, and lockfile content", () => {
  const ignore = readText(".semgrepignore");

  for (const pattern of [
    "js/vendor/",
    "js/addon-SDK-*.js",
    "runtime/",
    "node_modules/",
    "tools/.gen/",
    "package-lock.json"
  ]) {
    assert.match(ignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});
