import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:18878",
  out = path.resolve("data/v3-evidence");
const session = await fetch(base + "/api/session");
const { token } = (await session.json()) as any;
const cookie = session.headers.get("set-cookie")!.split(";")[0];
async function req(route: string, body?: unknown, method?: string) {
  const r = await fetch(base + "/api" + route, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: {
      Cookie: cookie,
      "X-Forma-Session": token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, value: (await r.json()) as any };
}
async function api(route: string, body?: unknown, method?: string) {
  const { status, value } = await req(route, body, method);
  assert(status < 300, JSON.stringify(value));
  return value;
}
for (let i = 0; i < 60; i++) {
  if ((await api("/health")).ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const v = JSON.parse(fs.readFileSync(path.join(out, "recording.json"), "utf8")),
  pid = v.projectId;
const result: Record<string, unknown> = {};
const other = await api("/projects", { name: "V3 隔离验证" });
assert((await req(`/projects/${other.id}/videos`, v.trajectory)).status >= 400);
result.crossRevisionRejected = true;
assert(
  (await req(`/projects/${other.id}/videos/${v.id}/render`, {})).status >= 400,
);
result.crossVideoRejected = true;
assert(
  (
    await req(`/projects/${pid}/videos`, {
      ...v.trajectory,
      settings: { ...v.settings, width: 257 },
    })
  ).status >= 400,
);
result.badSizeRejected = true;
const copy = await api(`/projects/${pid}/videos`, v.trajectory);
const bad = await fetch(
  `${base}/api/projects/${pid}/videos/${copy.id}/upload`,
  {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-Forma-Session": token,
      "Content-Type": "application/octet-stream",
    },
    body: Buffer.from("fake video"),
  },
);
assert(bad.status >= 400);
result.invalidMediaRejected = true;
const upload = fs.readFileSync(path.join(out,`FormaDesk-${v.revisionId}.mp4`));
const good = await fetch(
  `${base}/api/projects/${pid}/videos/${copy.id}/upload`,
  {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-Forma-Session": token,
      "Content-Type": "application/octet-stream",
    },
    body: upload,
  },
);
assert(good.ok, await good.text());
result.uploadRetry = true;
const trajectory = {
  ...v.trajectory,
  settings: { ...v.settings, width: 256, height: 256, mode: "blender" },
  samples: v.trajectory.samples.map((s: any) => ({
    ...s,
    camera: { ...s.camera, aspect: 1 },
  })),
};
const render = await api(`/projects/${pid}/videos`, trajectory);
const job = await api(`/projects/${pid}/videos/${render.id}/render`, {});
assert((await req(`/projects/${pid}/trash`, {})).status === 409);
result.runningDeleteRejected = true;
let active = job;
for (let i = 0; i < 100; i++) {
  active = await api(`/jobs/${job.id}`);
  if (active.progress?.completed > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
assert(active.progress?.completed > 0);
await api(`/jobs/${job.id}/cancel`, {});
for (let i = 0; i < 60; i++) {
  active = await api(`/jobs/${job.id}`);
  if (active.status === "cancelled") break;
  await new Promise((r) => setTimeout(r, 250));
}
assert.equal(active.status, "cancelled");
const dir = path.resolve("data/v3-test/videos", pid, render.id, "frames");
const frame = fs.readdirSync(dir).find((n) => n.endsWith(".png"))!;
const before = fs.statSync(path.join(dir, frame)).mtimeMs;
const retry = await api(`/projects/${pid}/videos/${render.id}/render`, {});
assert(retry.id !== job.id);
let terminal = retry;
while (["queued", "running"].includes(terminal.status)) {
  await new Promise((r) => setTimeout(r, 1000));
  terminal = await api(`/jobs/${retry.id}`);
}
assert.equal(terminal.status, "succeeded", terminal.error);
const log = fs.readFileSync(
  path.join(path.dirname(dir), "execution.log"),
  "utf8",
);
assert(/FORMA_VIDEO_REUSED_FRAMES [1-9]/.test(log));
result.cancelAndRetry = {
  retainedFrame: frame,
  mtimeBefore: before,
  reusedFrames: log.match(/FORMA_VIDEO_REUSED_FRAMES (\d+)/)?.[1],
  result: terminal.status,
};
await api(`/projects/${pid}/trash`, {});
assert((await req(`/projects/${pid}/videos`, v.trajectory)).status === 409);
await api(`/projects/${pid}/untrash`, {});
const scene = await api(`/projects/${pid}/scene`);
assert(scene.videos.some((a: any) => a.id === v.id && a.artifactId));
result.trashRestorePreservesVideos = true;
await api(`/projects/${other.id}/trash`, {});
await api(`/projects/${other.id}`, { confirm: true }, "DELETE");
result.emptyProjectPurge = true;
fs.writeFileSync(
  path.join(out, "boundaries.json"),
  JSON.stringify(result, null, 2),
);
console.log(result);
