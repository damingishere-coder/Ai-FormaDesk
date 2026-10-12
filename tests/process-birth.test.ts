import { afterAll, afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { registerVisualProcess, runProcess, reapInterruptedProcesses } from "../server/process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-process-birth-"));
const originalLocale = process.env.LC_ALL, originalTimezone = process.env.TZ;
function canonicalBirth(pid: number) {
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  }).trim();
}
afterEach(() => {
  if (originalLocale === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = originalLocale;
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it("visual registry 的出生时间不受父进程中文/法文或 Shanghai/Pacific 时区影响", () => {
  const registry = path.join(root, "visual");
  for (const [locale, timezone] of [["zh_CN.UTF-8", "Asia/Shanghai"], ["fr_FR.UTF-8", "America/Los_Angeles"]]) {
    process.env.LC_ALL = locale; process.env.TZ = timezone;
    const release = registerVisualProcess(process.pid, registry, root);
    try {
      const files = fs.readdirSync(registry);
      expect(files).toHaveLength(1);
      const record = JSON.parse(fs.readFileSync(path.join(registry, files[0]), "utf8"));
      expect(record.started).toBe(canonicalBirth(process.pid));
    } finally { release(); }
  }
});

it("runProcess 写入 canonical worker 身份，正常退出释放登记", async () => {
  process.env.LC_ALL = "fr_FR.UTF-8"; process.env.TZ = "America/Los_Angeles";
  const registry = path.join(root, "worker");
  const result = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 250)"], { registryDir: registry, cwd: root, timeout: 2000 });
  const records = fs.readdirSync(registry);
  expect(records).toHaveLength(1);
  const record = JSON.parse(fs.readFileSync(path.join(registry, records[0]), "utf8"));
  expect(record.started).toBe(canonicalBirth(record.pid));
  expect((await result).code).toBe(0);
  expect(fs.readdirSync(registry)).toEqual([]);
});

it("旧 locale/TZ registry 与 canonical 身份不匹配时，不终止仍存活的测试 worker", async () => {
  process.env.LC_ALL = "fr_FR.UTF-8"; process.env.TZ = "America/Los_Angeles";
  const dir = path.join(root, "legacy-worker");
  fs.mkdirSync(dir);
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", dir, "Blender"], { detached: true, stdio: "ignore" });
  const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
  try {
    const legacyBirth = execFileSync("/bin/ps", ["-p", String(worker.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    expect(legacyBirth).not.toBe(canonicalBirth(worker.pid!));
    fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({ pid: worker.pid, started: legacyBirth, cwd: dir }));
    reapInterruptedProcesses(dir);
    expect(() => process.kill(worker.pid!, 0)).not.toThrow();
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await exited;
  }
}, 5000);
