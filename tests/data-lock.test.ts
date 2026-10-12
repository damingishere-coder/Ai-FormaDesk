import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockDesktopData } from "../server/data-lock";

const roots: string[] = [];
const children: ChildProcess[] = [];
const releases: (() => void)[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forma-data-owner-"));
  roots.push(dir);
  return dir;
};
const ownerFile = (dir: string) => path.join(dir, ".desktop-owner.json");
const readOwner = (dir: string) => JSON.parse(fs.readFileSync(ownerFile(dir), "utf8"));

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DATA 所有权锁", () => {
  it("拒绝仍存活的同目录所有者，主动释放只删除自己的锁", () => {
    const dir = root();
    const release = lockDesktopData(dir);
    releases.push(release);
    expect(readOwner(dir).pid).toBe(process.pid);
    expect(readOwner(dir).birthFormat).toBe("ps-lstart-c-utc-v1");
    expect(fs.statSync(ownerFile(dir)).mode & 0o777).toBe(0o600);
    expect(() => lockDesktopData(dir)).toThrow(/另一个/);
    release();
    expect(fs.readdirSync(dir)).toEqual([]);
    releases.push(lockDesktopData(dir));
  });

  it("PID 相同但出生时间不同的旧锁可以恢复", () => {
    const dir = root();
    fs.writeFileSync(ownerFile(dir), JSON.stringify({ pid: process.pid, started: "previous process", token: "stale", birthFormat: "ps-lstart-c-utc-v1" }));
    releases.push(lockDesktopData(dir));
    expect(readOwner(dir).token).not.toBe("stale");
    expect(readOwner(dir).started).not.toBe("previous process");
    expect(fs.readdirSync(dir)).toEqual([".desktop-owner.json"]);
  });

  it("legacy 活 PID 即使出生字符串不同也拒绝，不把语言/时区变化当作 PID 重用", () => {
    const dir = root();
    const legacy = JSON.stringify({ pid: process.pid, started: "旧语言与时区的出生信息", token: "legacy-alive" });
    fs.writeFileSync(ownerFile(dir), legacy);
    expect(() => lockDesktopData(dir)).toThrow(/另一个/);
    expect(fs.readFileSync(ownerFile(dir), "utf8")).toBe(legacy);
    expect(fs.readdirSync(dir)).toEqual([".desktop-owner.json"]);
  });

  it("legacy 所有者真实退出后可依据 ESRCH 恢复", () => {
    const dir = root();
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(exited.status).toBe(0);
    expect(() => process.kill(exited.pid, 0)).toThrow();
    fs.writeFileSync(ownerFile(dir), JSON.stringify({ pid: exited.pid, started: "legacy process", token: "legacy-dead" }));
    releases.push(lockDesktopData(dir));
    expect(readOwner(dir).pid).toBe(process.pid);
    expect(readOwner(dir).birthFormat).toBe("ps-lstart-c-utc-v1");
  });

  it("释放函数不会删除已经替换为另一个所有者的锁", () => {
    const dir = root();
    const release = lockDesktopData(dir);
    const replacement = { ...readOwner(dir), token: "new-owner" };
    fs.writeFileSync(ownerFile(dir), JSON.stringify(replacement));
    release();
    expect(readOwner(dir)).toEqual(replacement);
  });

  it.each([
    "{broken json",
    "null",
    JSON.stringify({ pid: 1, started: "invalid", token: "bad" }),
    JSON.stringify({ pid: process.pid, token: "missing-birth" }),
    JSON.stringify({ pid: process.pid, started: "invalid" }),
  ])("坏锁安全拒绝，不覆盖元数据：%s", value => {
    const dir = root();
    fs.writeFileSync(ownerFile(dir), value);
    expect(() => lockDesktopData(dir)).toThrow(/锁文件损坏/);
    expect(fs.readFileSync(ownerFile(dir), "utf8")).toBe(value);
    expect(fs.readdirSync(dir)).toEqual([".desktop-owner.json"]);
  });

  it("符号链接锁和中断的恢复守卫安全拒绝", () => {
    const dir = root();
    const target = path.join(dir, "other.json");
    fs.writeFileSync(target, JSON.stringify({ pid: process.pid, started: "old", token: "old" }));
    fs.symlinkSync(target, ownerFile(dir));
    expect(() => lockDesktopData(dir)).toThrow(/锁文件损坏/);
    expect(fs.lstatSync(ownerFile(dir)).isSymbolicLink()).toBe(true);
    fs.unlinkSync(ownerFile(dir));
    fs.mkdirSync(path.join(dir, ".desktop-owner-recovery"));
    expect(() => lockDesktopData(dir)).toThrow(/所有权正在恢复/);
    expect(fs.readdirSync(dir).sort()).toEqual([".desktop-owner-recovery", "other.json"]);
  });

  it("多个真实进程同时争用陈旧锁，只有一个成功且锁保持属于胜者", async () => {
    const dir = root();
    fs.writeFileSync(ownerFile(dir), JSON.stringify({ pid: process.pid, started: "old instance", token: "stale", birthFormat: "ps-lstart-c-utc-v1" }));
    const module = new URL("../server/data-lock.ts", import.meta.url).href;
    const contenders = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { lockDesktopData } from ${JSON.stringify(module)};
        process.on('message', () => {
          try {
            const release = lockDesktopData(${JSON.stringify(dir)});
            process.send({ type: 'winner', pid: process.pid });
            process.once('SIGTERM', () => { release(); process.exit(0); });
          } catch (error) {
            process.send({ type: 'refused', message: error.message });
            process.exit(1);
          }
        });
        process.send({ type: 'ready' });
      `], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
      return child;
    });
    function message(child: ChildProcess, type: string) {
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`contender did not send ${type}`)), 10000);
        const listener = (value: any) => {
          if (type === "result" ? ["winner", "refused"].includes(value.type) : value.type === type) {
            clearTimeout(timer); child.off("message", listener); resolve(value);
          }
        };
        child.on("message", listener);
      });
    }
    await Promise.all(contenders.map(child => message(child, "ready")));
    const results = contenders.map(child => message(child, "result"));
    contenders.forEach(child => child.send("start"));
    const settled = await Promise.all(results);
    const winners = settled.filter(value => value.type === "winner");
    expect(winners).toHaveLength(1);
    expect(settled.filter(value => value.type === "refused")).toHaveLength(5);
    expect(readOwner(dir).pid).toBe(winners[0].pid);
    expect(fs.readdirSync(dir)).toEqual([".desktop-owner.json"]);
    const winner = contenders.find(child => child.pid === winners[0].pid)!;
    const stopped = new Promise<void>(resolve => winner.once("exit", () => resolve()));
    winner.kill("SIGTERM");
    await stopped;
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 20000);
});
