import { request as rawHttp } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import DB from "better-sqlite3";
import { ROOT, DATA } from "../server/config";
import { runProcess } from "../server/process";
const root = path.join(DATA, "fault-checks", String(Date.now()));
fs.mkdirSync(root, { recursive: true });
const results: any[] = [];
const origin = "http://127.0.0.1:18876";
let child: ChildProcess | undefined,
  token = "";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail });
    console.log("PASS", name, detail || "");
  } catch (e) {
    results.push({ name, passed: false, error: (e as Error).message });
    console.error("FAIL", name, (e as Error).message);
  }
}
async function waitFor(fn: () => Promise<boolean>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await pause(40);
  }
  throw new Error("等待测试状态超时");
}
const http = async (url: string, body?: unknown) => {
  const r = await fetch(origin + "/api" + url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: `forma_session=${token}`,
      "X-Forma-Session": token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: r.status, body: await r.json() };
};
async function boot() {
  child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "server/index.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, ZAOWU_DATA_DIR: root, ZAOWU_PORT: "18876" },
      stdio: "ignore",
    },
  );
  await waitFor(async () => {
    const r = await fetch(origin + "/api/session");
    token = ((await r.json()) as any).token;
    return !!token;
  });
  await waitFor(async () => (await http("/health")).body.ok, 60000);
}
// Clone a real successfully saved scene into an isolated test data store.
const final = JSON.parse(
  fs.readFileSync(path.join(DATA, "acceptance/final-scene.json"), "utf8"),
);
const source = new DB(path.join(DATA, "index.sqlite"), { readonly: true });
const db = new DB(path.join(root, "index.sqlite"));
db.exec(
  "CREATE TABLE documents(kind TEXT NOT NULL,id TEXT NOT NULL,projectId TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));",
);
const records = [
  ["project", final.project.id],
  ["revision", final.revision.id],
  ...Object.values(final.revision.artifacts).map((id) => ["artifact", id]),
];
for (const [kind, id] of records) {
  const v = JSON.parse(
    (
      source
        .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
        .get(kind, id) as any
    ).body,
  );
  if (kind === "artifact") {
    const dir = path.join(root, "revisions", final.revision.id);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(v.path));
    fs.copyFileSync(v.path, target);
    v.path = target;
  }
  if (kind === "project") {
    v.currentRevisionId = final.revision.id;
    v.threadId = null;
    v.redo = [];
  }
  db.prepare("INSERT INTO documents VALUES (?,?,?,?)").run(
    kind,
    id,
    v.projectId || null,
    JSON.stringify(v),
  );
}
source.close();
db.close();
const pid = final.project.id,
  base = final.revision.id;
const saved = path.join(root, "revisions", base, "scene.blend");
const hash = () =>
  createHash("sha256").update(fs.readFileSync(saved)).digest("hex");
const before = hash();
try {
  await boot();
  await check("HTTP Host、Origin、本地会话和 CSRF 校验", async () => {
    assert.equal((await fetch(origin + "/api/projects")).status, 401);
    assert.equal(
      await new Promise<number>((resolve, reject) => {
        const r = rawHttp(
          origin + "/api/session",
          { headers: { Host: "attacker.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        r.on("error", reject);
        r.end();
      }),
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/session", {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/projects", {
          method: "POST",
          headers: {
            Cookie: `forma_session=${token}`,
            "Content-Type": "application/json",
          },
          body: '{"name":"CSRF"}',
        })
      ).status,
      403,
    );
    for (const url of ["/api%2fprojects", "/%61pi/projects", "//api/projects"])
      assert.notEqual((await fetch(origin + url)).status, 200);
  });
  await check("旧版本提交拒绝且文件不变", async () => {
    const r = await http(`/projects/${pid}/commands`, {
      baseRevisionId: randomUUID(),
      objectId: final.scene.objects[0].id,
      operation: "delete",
    });
    assert.equal(r.code, 409);
    assert.equal(hash(), before);
  });
  await check("真实渲染进程中断与重启恢复", async () => {
    const r = await http(`/projects/${pid}/render`, {
      baseRevisionId: base,
      camera: final.render.camera,
    });
    assert.equal(r.code, 202);
    const jid = r.body.id;
    let proc: any;
    await waitFor(async () => {
      const registry = path.join(root, "runtime-processes");
      if (!fs.existsSync(registry)) return false;
      for (const name of fs.readdirSync(registry)) {
        const v = JSON.parse(
          fs.readFileSync(path.join(registry, name), "utf8"),
        );
        if (v.cwd.includes(jid)) {
          proc = v;
          return true;
        }
      }
      return false;
    });
    child!.kill("SIGKILL");
    await new Promise((r) => child!.once("exit", r));
    await boot();
    const job = await http(`/jobs/${jid}`);
    assert.equal(job.body.status, "failed");
    await waitFor(async () => {
      try {
        process.kill(proc.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(hash(), before);
    assert.equal(
      (await http(`/projects/${pid}/scene`)).body.project.currentRevisionId,
      base,
    );
    return { jobId: jid, interruptedPid: proc.pid, status: job.body.status };
  });
  await check("取消 API 终止渲染，SSE 重连读取终态", async () => {
    const r = await http(`/projects/${pid}/render`, {
      baseRevisionId: base,
      camera: final.render.camera,
    });
    assert.equal(r.code, 202);
    await http(`/jobs/${r.body.id}/cancel`, {});
    await waitFor(
      async () =>
        (await http(`/jobs/${r.body.id}`)).body.status === "cancelled",
    );
    for (let i = 0; i < 2; i++) {
      const e = await fetch(origin + `/api/jobs/${r.body.id}/events`, {
        headers: {
          Cookie: `forma_session=${token}`,
          "Last-Event-ID": "earlier-event",
        },
      });
      const text = await e.text();
      assert.match(text, /"status":"cancelled"/);
    }
    assert.equal(hash(), before);
  });
} finally {
  child?.kill("SIGTERM");
  if (child?.exitCode === null)
    await new Promise((r) => child!.once("exit", r));
}
await check("Blender 缺失实际启动检查", async () => {
  const r = await runProcess(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts/check-environment.ts")],
    {
      cwd: ROOT,
      timeout: 30000,
      env: {
        ...process.env,
        ZAOWU_DATA_DIR: path.join(root, "missing"),
        ZAOWU_BLENDER: path.join(root, "not-installed/Blender"),
      },
    },
  );
  const v = JSON.parse(r.stdout);
  assert.equal(v.blender.ok, false);
  assert.equal(v.ok, false);
  return v.blender.error;
});
await check("独立空白 CODEX_HOME 未登录检测，不修改现有登录", async () => {
  const home = path.join(root, "empty-codex-home");
  fs.mkdirSync(home);
  const r = await runProcess(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts/check-environment.ts")],
    {
      cwd: ROOT,
      timeout: 45000,
      env: {
        ...process.env,
        CODEX_HOME: home,
        ZAOWU_DATA_DIR: path.join(root, "no-login"),
        ZAOWU_BLENDER: path.join(root, "not-installed/Blender"),
      },
    },
  );
  const v = JSON.parse(r.stdout);
  assert.equal(v.codex.ok, false);
  assert.equal(v.codex.loggedIn, false);
  return { loggedIn: v.codex.loggedIn, error: v.codex.error };
});
fs.writeFileSync(
  path.join(root, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log("FAULT_RESULTS", path.join(root, "results.json"));
if (results.some((r) => !r.passed)) process.exitCode = 1;
