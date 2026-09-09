const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

module.exports = async function verifyPackagedRuntime(context) {
  const runtime = path.join(
    context.appOutDir,
    "Ai-FormaDesk.app/Contents/Resources/runtime",
  );
  const pkg = JSON.parse(
    fs.readFileSync(path.join(runtime, "package.json"), "utf8"),
  );
  const modules = path.join(runtime, "node_modules") + path.sep;
  const resolve = createRequire(path.join(runtime, "server/index.mjs")).resolve;
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(
      fs.existsSync(path.join(modules, name, "package.json")),
      `Missing packaged dependency: ${name}`,
    );
  }
  for (const name of [
    "@modelcontextprotocol/sdk/client/index.js",
    "fastify",
    "better-sqlite3",
    "sharp",
  ]) {
    assert.ok(
      resolve(name).startsWith(modules),
      `Dependency resolved outside app: ${name}`,
    );
  }
  console.log(
    "Packaged backend dependencies verified inside application resources.",
  );
};
