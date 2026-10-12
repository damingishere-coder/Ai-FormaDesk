import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requireLiveEnvironment } from "../scripts/require-live-environment";

const original = { ...process.env };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "formadesk-live-script-guards-"));
const invalidDir = fs.mkdtempSync(path.join(os.tmpdir(), "forma-wrong-live-script-"));
const scripts = [
  "verify-preview-fast.ts", "verify-visual-preservation.ts", "verify-visual-blender.ts",
  "verify-threeview-live.ts", "verify-visual-cli.ts", "compare-threeview.ts", "verify-visual-transport.ts",
  "verify-v2.ts", "verify-v3-video.ts", "verify-v3-boundaries.ts", "gizmo-drag.ts",
  "capture-delivery.ts", "verify-object-actions.ts", "verify-single-pass-live.ts", "verify-image-composition.ts", "visual-fixtures.ts",
  "integration.ts", "fault-checks.ts", "verify-blender-mcp.ts", "verify-blender-mcp-boundaries.ts",
];
const aiScripts = ["verify-threeview-live.ts", "verify-visual-cli.ts", "compare-threeview.ts", "verify-visual-transport.ts", "verify-v2.ts", "verify-single-pass-live.ts", "verify-blender-mcp-boundaries.ts"];
const httpScripts = ["verify-v2.ts", "verify-v3-video.ts", "verify-v3-boundaries.ts", "gizmo-drag.ts", "capture-delivery.ts", "verify-object-actions.ts", "verify-single-pass-live.ts"];

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
  Object.assign(process.env, original);
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(invalidDir, { recursive: true, force: true });
});

function rejectScript(script: string, env: NodeJS.ProcessEnv, expected: RegExp) {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve("scripts", script)], {
    cwd: process.cwd(),
    env: {
      ...original,
      FORMA_LIVE_TESTS: "0", FORMA_REAL_AI: "0", FORMA_LIVE_URL: "",
      ZAOWU_DATA_DIR: dataDir,
      // A broken guard must still never invoke installed real tools.
      ZAOWU_CODEX: path.join(dataDir, "not-installed-codex"),
      ZAOWU_BLENDER: path.join(dataDir, "not-installed-blender"),
      ...env,
    },
    encoding: "utf8", timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(expected);
  // Missing authorization is rejected before server/config creates SQLite,
  // ownership records, proof folders, screenshots or fixture outputs.
  expect(fs.readdirSync(dataDir)).toEqual([]);
  expect(fs.readdirSync(invalidDir)).toEqual([]);
}

describe("旧 live 脚本入口安全护栏", () => {
  it("全部 20 个真实脚本/夹具在无 opt-in 时先拒绝，不写 DATA/不启动工具", () => {
    for (const script of scripts) rejectScript(script, {}, /必须显式设置 FORMA_LIVE_TESTS=1/);
  }, 30000);
  it("全部 20 个脚本/夹具拒绝不符合隔离规则的目录", () => {
    for (const script of scripts)
      rejectScript(script, { FORMA_LIVE_TESTS: "1", ZAOWU_DATA_DIR: invalidDir }, /系统临时目录内独立的 formadesk-live/);
  }, 30000);
  it("AI 脚本单独要求真实调用授权，拒绝发生在 store import 前", () => {
    for (const script of aiScripts)
      rejectScript(script, { FORMA_LIVE_TESTS: "1" }, /必须显式设置 FORMA_REAL_AI=1/);
  }, 20000);
  it("HTTP 和浏览器脚本没有默认地址，缺显式 URL 即拒绝", () => {
    for (const script of httpScripts)
      rejectScript(script, { FORMA_LIVE_TESTS: "1", FORMA_REAL_AI: "1" }, /必须显式设置独立后台 FORMA_LIVE_URL/);
  }, 20000);
  it("目录和 URL 校验本身是只读；循环本机地址还必须匹配 DATA 的后台记录", () => {
    process.env.FORMA_LIVE_TESTS = "1";
    process.env.ZAOWU_DATA_DIR = dataDir;
    expect(requireLiveEnvironment()).toEqual({ dataDir: fs.realpathSync(dataDir) });
    for (const url of ["http://127.0.0.1:8765", "http://127.0.0.1:5173", "http://localhost:19145", "https://example.com:19145", "http://user:password@127.0.0.1:19145", "http://127.0.0.1:19145/other"]) {
      process.env.FORMA_LIVE_URL = url;
      expect(() => requireLiveEnvironment({ http: true })).toThrow(/独立端口/);
    }
    process.env.FORMA_LIVE_URL = "http://127.0.0.1:19145";
    expect(() => requireLiveEnvironment({ http: true })).toThrow(/隔离后台尚未就绪/);
    const cacheDir = path.join(dataDir, "project-library");
    fs.mkdirSync(cacheDir);
    const cache = path.join(cacheDir, "index.json");
    try {
      fs.writeFileSync(cache, JSON.stringify({ dataRoot: invalidDir, baseUrl: process.env.FORMA_LIVE_URL }));
      expect(() => requireLiveEnvironment({ http: true })).toThrow(/不匹配/);
      fs.writeFileSync(cache, JSON.stringify({ dataRoot: fs.realpathSync(dataDir), baseUrl: process.env.FORMA_LIVE_URL }));
      expect(requireLiveEnvironment({ http: true })).toEqual({ dataDir: fs.realpathSync(dataDir), baseURL: process.env.FORMA_LIVE_URL });
    } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });
  it("实际临时目录可以读取；目录符号链接或非绝对路径安全拒绝", () => {
    process.env.FORMA_LIVE_TESTS = "1";
    process.env.ZAOWU_DATA_DIR = "data/formadesk-live-relative";
    expect(() => requireLiveEnvironment()).toThrow(/绝对路径/);
    const link = path.join(invalidDir, "formadesk-live-alias");
    fs.symlinkSync(dataDir, link);
    try {
      process.env.ZAOWU_DATA_DIR = link;
      expect(() => requireLiveEnvironment()).toThrow(/不能是符号链接/);
    } finally { fs.unlinkSync(link); }
    expect(fs.readdirSync(dataDir)).toEqual([]);
    expect(fs.readdirSync(invalidDir)).toEqual([]);
  });
});
