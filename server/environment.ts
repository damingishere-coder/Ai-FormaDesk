import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { BLENDER, DATA, ROOT } from "./config";
import { runProcess } from "./process";
import { runBlender } from "./sandbox";
import { codex } from "./codex";
import { imageEnvironment } from "./image3d";
export let environment: any = {
  ok: false,
  checking: true,
  blender: { ok: false },
  sandbox: { ok: false },
  codex: { ok: false },
};
let checking: Promise<any> | null = null;
export async function checkEnvironment() {
  if (checking) return checking;
  checking = perform().finally(() => (checking = null));
  return checking;
}
async function perform() {
  environment = { ...environment, checking: true };
  const ai = await codex.health();
  const image3d = await imageEnvironment();
  let blender: any = {
      ok: false,
      path: BLENDER,
      error: "未找到 Blender 4.5 LTS。请在本地设置中指定安装路径后重启。",
    },
    sandbox: any = { ok: false, error: "尚未验证" };
  if (fs.existsSync(BLENDER))
    try {
      const r = await runProcess(BLENDER, ["--version"]);
      blender = {
        ok: r.code === 0 && /^Blender 4\.5\./.test(r.stdout),
        path: BLENDER,
        version: r.stdout.split("\n")[0],
      };
      if (!blender.ok) blender.error = "需要 Blender 4.5 LTS";
    } catch (e) {
      blender.error = (e as Error).message;
    }
  if (blender.ok)
    try {
      const probes = path.join(DATA, "sandbox-checks");
      fs.mkdirSync(probes, { recursive: true });
      const job = fs.mkdtempSync(path.join(probes, "run-"));
      const canary = path.join(probes, "canary.txt");
      fs.writeFileSync(canary, "forma-canary");
      const server = net.createServer((s) => s.end());
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as net.AddressInfo).port;
      fs.writeFileSync(
        path.join(job, "probe-input.json"),
        JSON.stringify({
          read: canary,
          write: path.join(probes, "escape.txt"),
          port,
        }),
      );
      try {
        const r = await runBlender(
          job,
          ["--python", path.join(ROOT, "blender/probe.py")],
          undefined,
          45000,
        );
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).slice(-2000));
        const result = JSON.parse(
          fs.readFileSync(path.join(job, "probe-result.json"), "utf8"),
        );
        const rr = await runBlender(
          job,
          ["--python", path.join(ROOT, "blender/probe.py")],
          undefined,
          45000,
          true,
        );
        if (rr.code !== 0) throw new Error(rr.stderr || "渲染沙箱检查失败");
        const renderResult = JSON.parse(
          fs.readFileSync(path.join(job, "probe-result.json"), "utf8"),
        );
        sandbox = {
          ok: [result, renderResult].every(
            (v) =>
              ["read", "write", "network", "externalNetwork"].every(
                (k) => v[k]?.blocked === true,
              ) && v.credentialsAbsent === true,
          ),
          result,
          renderResult,
          checkedAt: new Date().toISOString(),
        };
        if (!sandbox.ok)
          sandbox.error = "沙箱限制未通过，已停用生成和 Blender 执行";
      } finally {
        server.close();
      }
    } catch (e) {
      sandbox = { ok: false, error: (e as Error).message };
    }
  environment = {
    ok: ai.ok && blender.ok && sandbox.ok,
    checking: false,
    codex: ai,
    blender,
    sandbox,
    image3d,
  };
  return environment;
}
export function assertExecution() {
  if (!environment.blender.ok || !environment.sandbox.ok)
    throw Object.assign(
      new Error(
        environment.checking
          ? "环境检查仍在等待本机计算资源或执行中，请稍候。"
          : "Blender 或沙箱检查未通过，执行已停用。请打开环境检查。",
      ),
      { statusCode: 503 },
    );
}
