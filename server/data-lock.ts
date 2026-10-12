import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

type Owner = { pid: number; started: string; token: string };

function birth(pid: number) {
  const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!value) throw new Error("无法确认数据目录所有者的进程身份。");
  return value;
}

function readOwner(file: string): Owner {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid file");
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !Number.isSafeInteger(owner.pid) || owner.pid < 2 ||
      typeof owner.started !== "string" || !owner.started.trim() ||
      typeof owner.token !== "string" || !owner.token
    ) throw new Error("invalid owner");
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("数据目录锁文件损坏，请先确认没有工作台运行，再移除 .desktop-owner.json。");
  }
}

function isAlive(owner: Owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM and failed identity probes cannot establish that an owner is stale.
    throw new Error("无法确认数据目录所有者，已拒绝写入。");
  }
  return birth(owner.pid) === owner.started;
}

/** Every DATA writer owns the directory before opening SQLite or recovering jobs. */
export function lockDesktopData(dir: string) {
  const file = path.join(dir, ".desktop-owner.json");
  const recovering = path.join(dir, ".desktop-owner-recovery");
  const owner: Owner = {
    pid: process.pid,
    started: birth(process.pid),
    token: randomUUID(),
  };
  const temporary = path.join(dir, `.desktop-owner-${owner.token}.tmp`);
  // Publish a complete record atomically: another process must never mistake a
  // half-written wx file for corrupt ownership metadata.
  fs.writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  let acquired = false;
  try {
    if (fs.existsSync(recovering))
      throw new Error("数据目录所有权正在恢复；若进程已退出，请确认后移除 .desktop-owner-recovery，再重试。");
    try {
      fs.linkSync(temporary, file);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readOwner(file);
      if (isAlive(previous))
        throw new Error("作品数据正在被另一个工作台或维护脚本使用，请先退出旧进程。");
      // Serialize stale reclamation. Never automatically delete this short-lived
      // recovery guard: an interrupted recovery fails closed for manual inspection.
      try {
        fs.mkdirSync(recovering, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("数据目录所有权正在由另一个进程恢复，请稍后重试。");
        throw error;
      }
      try {
        // A prior owner may have exited and released between the first read and
        // the recovery guard. Recheck before deleting, so a new owner is untouched.
        try {
          const current = readOwner(file);
          if (isAlive(current))
            throw new Error("作品数据正在被另一个工作台或维护脚本使用，请先退出旧进程。");
          fs.unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        fs.linkSync(temporary, file);
        acquired = true;
      } finally {
        fs.rmdirSync(recovering);
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  if (!acquired) throw new Error("无法取得作品数据目录锁，请重试。");
  const release = () => {
    process.removeListener("exit", release);
    try {
      if (readOwner(file).token === owner.token) fs.unlinkSync(file);
    } catch { /* A replaced, missing or corrupt lock never belongs to us. */ }
  };
  process.once("exit", release);
  return release;
}
