import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "build/desktop-runtime");
const cache = path.join(root, "build/downloads");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("桌面构建需要 Apple Silicon Mac。");
fs.mkdirSync(cache, { recursive: true });
const nodeVersion = "22.23.2";
const archiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`;
const archive = path.join(cache, archiveName);
const checksum =
  "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6";
if (!fs.existsSync(archive)) {
  execFileSync(
    "/usr/bin/curl",
    [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--output",
      archive + ".tmp",
      `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`,
    ],
    { stdio: "inherit" },
  );
  fs.renameSync(archive + ".tmp", archive);
}
if (
  createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !==
  checksum
)
  throw new Error(
    "Node.js 下载校验失败，请删除 build/downloads 下对应下载文件后重试。",
  );
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", cache]);
const nodeRoot = path.join(cache, `node-v${nodeVersion}-darwin-arm64`);
fs.mkdirSync(path.join(stage, "bin"));
fs.copyFileSync(path.join(nodeRoot, "bin/node"), path.join(stage, "bin/node"));
fs.chmodSync(path.join(stage, "bin/node"), 0o755);
fs.copyFileSync(
  path.join(nodeRoot, "LICENSE"),
  path.join(stage, "NODE-LICENSE"),
);
for (const dir of ["dist", "blender"])
  fs.cpSync(path.join(root, dir), path.join(stage, dir), {
    recursive: true,
    filter: (source) =>
      !source.includes("__pycache__") && !source.endsWith(".pyc"),
  });
await build({
  entryPoints: [path.join(root, "server/index.ts")],
  outfile: path.join(stage, "server/index.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
// npm ci uses the exact repository lock; developer tools are excluded from runtime.
fs.copyFileSync(
  path.join(root, "package.json"),
  path.join(stage, "package.json"),
);
fs.copyFileSync(
  path.join(root, "package-lock.json"),
  path.join(stage, "package-lock.json"),
);
execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: stage,
  stdio: "inherit",
});
fs.writeFileSync(
  path.join(stage, "build-info.json"),
  JSON.stringify(
    {
      version: pkg.version,
      node: nodeVersion,
      platform: "darwin-arm64",
      dirty,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    },
    null,
    2,
  ),
);
console.log("Desktop runtime prepared:", stage);
