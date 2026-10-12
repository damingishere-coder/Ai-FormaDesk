import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "formadesk-live-startup-owner-"));
  roots.push(dir);
  return dir;
};
function childEnv(dir: string, port = 0) {
  return {
    ...process.env,
    ZAOWU_DATA_DIR: dir,
    ZAOWU_PORT: String(port),
    ZAOWU_DESKTOP_TOKEN: "",
    FORMA_LIVE_TESTS: "1",
    FORMA_REAL_AI: "0",
    // A test must not invoke the installed Codex or Blender.
    ZAOWU_CODEX: path.join(dir, "not-installed-codex"),
    ZAOWU_BLENDER: path.join(dir, "not-installed-blender"),
    ZAOWU_MCP_RUNTIME: path.join(dir, "not-installed-mcp"),
  };
}
function launch(dir: string, code: string, port = 0, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd, env: { ...childEnv(dir, port), ...environment }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", value => { output += value; });
  child.stderr?.on("data", value => { output += value; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>(resolve =>
    child.once("exit", (code, signal) => resolve({ code, signal, output })));
  return { child, closed, output: () => output };
}
function ready(instance: ReturnType<typeof launch>, type = "ready") {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${instance.output()}`)), 12000);
    const listener = (value: any) => {
      if (value?.type !== type) return;
      clearTimeout(timer); instance.child.off("message", listener); resolve(value);
    };
    instance.child.on("message", listener);
    instance.child.once("exit", () => {
      clearTimeout(timer); instance.child.off("message", listener);
      reject(new Error(`startup exited: ${instance.output()}`));
    });
  });
}
function snapshot(dir: string) {
  const db = new Database(path.join(dir, "index.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT kind,id,projectId,body FROM documents ORDER BY kind,id").all();
  } finally { db.close(); }
}
async function stop(instance: ReturnType<typeof launch>) {
  instance.child.send({ type: "stop" });
  return instance.closed;
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    // Fixtures clean up only the workers they spawned. Actual backend shutdown
    // follows its existing SIGTERM path and releases ownership at process exit.
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
    await exited;
    clearTimeout(timer);
  }));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const storeUrl = new URL("../server/store.ts", import.meta.url).href;
const configUrl = new URL("../server/config.ts", import.meta.url).href;
const indexUrl = new URL("../server/index.ts", import.meta.url).href;
function backend(dir: string, port = 0, environment: NodeJS.ProcessEnv = {}) {
  // Wait for the complete startup module, including shutdown signal handlers.
  return launch(dir, `await import(${JSON.stringify(indexUrl)}); process.send({ type: 'test-backend-ready' });`, port, environment);
}
function liveOwner(dir: string, environment: NodeJS.ProcessEnv = {}) {
  return launch(dir, `
    import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net';
    import { spawn, execFileSync } from 'node:child_process';
    const { put, db } = await import(${JSON.stringify(storeUrl)});
    const workerDir = path.join(process.env.ZAOWU_DATA_DIR, 'jobs', 'fixture');
    fs.mkdirSync(workerDir, { recursive: true });
    // This is our own harmless worker; its command matches the real reaper's
    // exact Blender + working-directory predicate, so a bad startup would kill it.
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', workerDir, 'Blender'], { detached: true, stdio: 'ignore' });
    worker.unref();
    const registry = path.join(process.env.ZAOWU_DATA_DIR, 'runtime-processes');
    fs.mkdirSync(registry);
    const started = execFileSync('/bin/ps', ['-p', String(worker.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(registry, 'fixture.json'), JSON.stringify({ pid: worker.pid, started, cwd: workerDir }));
    put('job', { id: 'running-fixture', projectId: 'project-fixture', status: 'running', type: 'generate' });
    put('message', { id: 'pending-fixture', projectId: 'project-fixture', status: 'pending', text: 'existing work' });
    const server = net.createServer(socket => socket.end());
    server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, workerPid: worker.pid }));
    let stopping = false;
    function stop() {
      if (stopping) return; stopping = true;
      worker.kill('SIGKILL');
      server.close(() => { db.close(); process.exit(0); });
    }
    process.on('message', message => { if (message.type === 'stop') stop(); });
    process.on('SIGTERM', stop);
  `, 0, environment);
}

describe("启动前的数据目录所有权", () => {
  it.each([
    { ownerLocale: "C", ownerTZ: "UTC", contenderLocale: "zh_CN.UTF-8", contenderTZ: "Asia/Shanghai" },
    { ownerLocale: "fr_FR.UTF-8", ownerTZ: "America/Los_Angeles", contenderLocale: "C", contenderTZ: "UTC" },
  ])("语言/时区变化 $ownerLocale/$ownerTZ → $contenderLocale/$contenderTZ 不会接管活 owner、不改 DB 或 worker", async scenario => {
    const dir = root();
    const owner = liveOwner(dir, { LC_ALL: scenario.ownerLocale, TZ: scenario.ownerTZ });
    const first = await ready(owner);
    const before = snapshot(dir);
    const record = fs.readFileSync(path.join(dir, "runtime-processes/fixture.json"), "utf8");
    const lock = fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8");
    const second = backend(dir, 0, { LC_ALL: scenario.contenderLocale, TZ: scenario.contenderTZ });
    // A regression that steals ownership starts successfully. Stop that test
    // instance so the failed assertion stays bounded and leaves no process.
    const accepted = ready(second, "test-backend-ready").then(async () => {
      second.child.kill("SIGTERM");
      return second.closed;
    }).catch(() => second.closed);
    const result = await Promise.race([second.closed, accepted]);
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/另一个工作台或维护脚本/);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "runtime-processes/fixture.json"), "utf8")).toBe(record);
    expect(fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8")).toBe(lock);
    expect(() => process.kill(first.workerPid, 0)).not.toThrow();
    expect((await stop(owner)).code).toBe(0);
  }, 20000);

  it.each(["same", "different"])("%s 端口的第二个真实后台不改 DB、不回收合法 worker", async mode => {
    const dir = root();
    const owner = liveOwner(dir);
    const first = await ready(owner);
    const before = snapshot(dir);
    const record = fs.readFileSync(path.join(dir, "runtime-processes/fixture.json"), "utf8");
    const lock = fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8");
    const second = backend(dir, mode === "same" ? first.port : 0);
    const result = await second.closed;
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/另一个工作台或维护脚本/);
    expect(result.output).not.toMatch(/EADDRINUSE/);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "runtime-processes/fixture.json"), "utf8")).toBe(record);
    expect(fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8")).toBe(lock);
    expect(() => process.kill(first.workerPid, 0)).not.toThrow();
    expect((await stop(owner)).code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".desktop-owner.json"))).toBe(false);
  }, 20000);

  it("仅导入 config 的只读客户端不会占用锁或创建 SQLite", async () => {
    const dir = root();
    const read = launch(dir, `await import(${JSON.stringify(configUrl)}); process.disconnect();`);
    expect((await read.closed).code).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
    const owner = liveOwner(dir);
    await ready(owner);
    const before = snapshot(dir);
    const readWithOwner = launch(dir, `await import(${JSON.stringify(configUrl)}); process.disconnect();`);
    expect((await readWithOwner.closed).code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    await stop(owner);
  }, 20000);

  it.each([
    "setup-project-library.ts", "verify-exports.ts", "fault-checks.ts",
    "reopen-v2.ts", "setup-blender-mcp.ts",
  ])("独立脚本 %s 在写文件、安装运行时或调用 Blender 之前拒绝已占用的 DATA", async script => {
    const dir = root();
    const owner = liveOwner(dir);
    await ready(owner);
    const before = snapshot(dir);
    const setup = new URL(`../scripts/${script}`, import.meta.url).href;
    const refused = launch(dir, `await import(${JSON.stringify(setup)});`);
    const result = await refused.closed;
    expect(result.output).toMatch(/另一个工作台或维护脚本/);
    expect(fs.existsSync(path.join(dir, "project-library"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "fault-checks"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "v2-evidence"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "not-installed-mcp"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
    await stop(owner);
  }, 20000);

  it("真实 backend 正常退出后释放锁，崩溃旧 owner 可以按出生时间恢复", async () => {
    const dir = root();
    const crashed = launch(dir, `
      const { put } = await import(${JSON.stringify(storeUrl)});
      put('job', { id: 'interrupted', projectId: 'project-fixture', status: 'running', type: 'generate' });
      process.send({ type: 'ready' });
      setInterval(() => {}, 1000);
    `);
    await ready(crashed);
    const staleLock = fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8");
    crashed.child.kill("SIGKILL");
    await crashed.closed;
    expect(fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8")).toBe(staleLock);
    const restarted = backend(dir);
    await ready(restarted, "test-backend-ready");
    const rows = snapshot(dir) as { kind: string; id: string; body: string }[];
    expect(JSON.parse(rows.find(row => row.id === "interrupted")!.body).status).toBe("failed");
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".desktop-owner.json"), "utf8")).pid).toBe(restarted.child.pid);
    restarted.child.kill("SIGTERM");
    expect((await restarted.closed).code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".desktop-owner.json"))).toBe(false);
    const next = backend(dir);
    await ready(next, "test-backend-ready");
    next.child.kill("SIGTERM");
    expect((await next.closed).code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".desktop-owner.json"))).toBe(false);
  }, 30000);

  it("坏锁在数据库初始化前拒绝，DATA 内不产生 SQLite", async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, ".desktop-owner.json"), "invalid");
    const refused = backend(dir);
    const result = await refused.closed;
    expect(result.output).toMatch(/锁文件损坏/);
    expect(fs.readdirSync(dir)).toEqual([".desktop-owner.json"]);
  }, 20000);

  it("真实 ready 通知后立即 SIGTERM 也能正常停止并释放锁", async () => {
    const dir = root();
    const started = backend(dir);
    await ready(started, "forma-ready");
    started.child.kill("SIGTERM");
    expect((await started.closed).code).toBe(0);
    expect(fs.existsSync(path.join(dir, ".desktop-owner.json"))).toBe(false);
  }, 20000);

  it("已占用端口启动失败会释放自己的锁，下一次可在空闲端口启动", async () => {
    const dir = root();
    const occupied = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
    try {
      const port = (occupied.address() as net.AddressInfo).port;
      const failed = backend(dir, port);
      expect((await failed.closed).output).toMatch(/EADDRINUSE/);
      expect(fs.existsSync(path.join(dir, ".desktop-owner.json"))).toBe(false);
      const next = backend(dir);
      await ready(next, "test-backend-ready");
      next.child.kill("SIGTERM");
      expect((await next.closed).code).toBe(0);
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  }, 30000);
});
