import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function runProcess(
  bin: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    registryDir?: string;
  } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      if (options.signal?.aborted) return reject(new Error("任务已取消"));
      const p = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        timeout = false;
      let record: string | undefined;
      if (options.registryDir && p.pid) {
        fs.mkdirSync(options.registryDir, { recursive: true });
        record = path.join(options.registryDir, randomUUID() + ".json");
        let started = "";
        try {
          started = execFileSync(
            "/bin/ps",
            ["-p", String(p.pid), "-o", "lstart="],
            { encoding: "utf8" },
          ).trim();
        } catch {}
        fs.writeFileSync(
          record,
          JSON.stringify({ pid: p.pid, started, cwd: options.cwd }),
          { mode: 0o600 },
        );
      }
      const kill = () => {
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {
          p.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timeout = true;
        kill();
      }, options.timeout || 15000);
      options.signal?.addEventListener("abort", kill, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        if (record) fs.rmSync(record, { force: true });
      };
      p.stdout.on("data", (b) => {
        stdout = (stdout + b.toString()).slice(-300000);
      });
      p.stderr.on("data", (b) => {
        stderr = (stderr + b.toString()).slice(-100000);
      });
      p.on("error", (e) => {
        cleanup();
        reject(e);
      });
      p.on("close", (code, exitSignal) => {
        cleanup();
        if (timeout) reject(new Error("执行超时，任务进程已停止"));
        else if (options.signal?.aborted) reject(new Error("任务已取消"));
        else
          resolve({
            stdout,
            stderr:
              stderr + (exitSignal ? "\n进程被信号终止：" + exitSignal : ""),
            code: code ?? -1,
          });
      });
    },
  );
}
/** Only terminate recorded child instances: PID + birth time + job directory must match. */
export function reapInterruptedProcesses(registry: string) {
  if (!fs.existsSync(registry)) return;
  for (const name of fs.readdirSync(registry)) {
    if (!name.endsWith(".json")) continue;
    const f = path.join(registry, name);
    try {
      const v = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!v.started || !Number.isInteger(v.pid) || v.pid < 2) continue;
      const start = execFileSync(
        "/bin/ps",
        ["-p", String(v.pid), "-o", "lstart="],
        { encoding: "utf8" },
      ).trim();
      const command = execFileSync(
        "/bin/ps",
        ["-p", String(v.pid), "-o", "command="],
        { encoding: "utf8" },
      ).trim();
      if (
        start === v.started &&
        command.includes(v.cwd) &&
        command.includes("Blender")
      )
        process.kill(-v.pid, "SIGKILL");
    } catch {
    } finally {
      fs.rmSync(f, { force: true });
    }
  }
}
