import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
function birth(pid: number) {
  return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
/** One desktop backend owns a data directory; stale locks are recoverable. */
export function lockDesktopData(dir: string) {
  const file = path.join(dir, ".desktop-owner.json");
  const owner = {
    pid: process.pid,
    started: birth(process.pid),
    token: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), {
        flag: "wx",
        mode: 0o600,
      });
      const release = () => {
        try {
          if (JSON.parse(fs.readFileSync(file, "utf8")).token === owner.token)
            fs.unlinkSync(file);
        } catch {}
      };
      process.once("exit", release);
      return release;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      let previous: { pid?: number; started?: string };
      try {
        previous = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "数据目录锁文件损坏，请先确认没有工作台运行，再移除 .desktop-owner.json。",
        );
      }
      if (!Number.isInteger(previous.pid) || previous.pid! < 2)
        throw new Error("数据目录锁文件无效。");
      try {
        process.kill(previous.pid!, 0);
      } catch (err: any) {
        if (err.code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
        throw err;
      }
      if (previous.started && birth(previous.pid!) !== previous.started) {
        fs.unlinkSync(file);
        continue;
      }
      throw new Error("作品数据正在被另一个桌面工作台使用，请先退出旧工作台。");
    }
  }
  throw new Error("无法取得作品数据目录锁，请重试。");
}
