import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { DATA } from "../../server/config";
import { IMAGE3D_RUNTIME, imagePython } from "../../server/image3d";
import { runBlender } from "../../server/sandbox";
if (!process.env.ZAOWU_DATA_DIR) throw new Error("需要隔离验证目录");
const dir = path.join(DATA, "resource-check"); fs.mkdirSync(dir, { recursive: true });
const holder = spawn(imagePython(), ["-c",
  "import fcntl,pathlib,sys,time; p=pathlib.Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True);f=(p/'inference.lock').open('a');fcntl.flock(f,fcntl.LOCK_EX);print('LEASE',flush=True);time.sleep(3)", IMAGE3D_RUNTIME], { stdio: ["ignore", "pipe", "pipe"] });
try {
  await Promise.race([once(holder.stdout!, "data"), once(holder, "error").then(([e]) => { throw e; })]);
  const start = Date.now();
  // Waiting for the Python inference lease must not consume Blender's budget.
  const result = await runBlender(dir, ["--version"], undefined, 1500);
  assert.equal(result.code, 0); assert.match(result.stdout, /Blender 4\.5/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 2800);
  const report = { sharedInferenceLease: true, queueExcludedFromTimeout: true, elapsedMs: elapsed, exitCode: result.code };
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { holder.kill(); }
