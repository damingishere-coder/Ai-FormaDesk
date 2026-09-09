import fs from "node:fs";
import path from "node:path";
const base = "http://127.0.0.1:18878";
const out = path.resolve("data/v3-evidence");
const session = await fetch(base + "/api/session");
const { token } = (await session.json()) as any;
const cookie = session.headers.get("set-cookie")!.split(";")[0];
async function api(route: string, body?: unknown) {
  const r = await fetch(base + "/api" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      "X-Forma-Session": token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(v));
  return v as any;
}
const recording = JSON.parse(
  fs.readFileSync(path.join(out, "recording.json"), "utf8"),
);
const trajectory = {
  ...recording.trajectory,
  settings: { ...recording.settings, mode: "blender" },
};
const video = await api(`/projects/${recording.projectId}/videos`, trajectory);
fs.writeFileSync(path.join(out, "blender-video.json"), JSON.stringify(video));
const job = await api(
  `/projects/${recording.projectId}/videos/${video.id}/render`,
  {},
);
let current = job,
  last = "";
while (["queued", "running"].includes(current.status)) {
  await new Promise((r) => setTimeout(r, 2000));
  current = await api(`/jobs/${job.id}`);
  const status = JSON.stringify({
    status: current.status,
    progress: current.progress,
  });
  if (status !== last) {
    console.log(status);
    last = status;
  }
}
fs.writeFileSync(
  path.join(out, "blender-video-job.json"),
  JSON.stringify(current, null, 2),
);
if (current.status !== "succeeded") throw new Error(current.error);
const scene = await api(`/projects/${recording.projectId}/scene`);
const final = scene.videos.find((v: any) => v.id === video.id);
const response = await fetch(base + `/api/artifacts/${final.artifactId}`, {
  headers: { Cookie: cookie },
});
fs.writeFileSync(
  path.join(out, "blender-video.mp4"),
  Buffer.from(await response.arrayBuffer()),
);
console.log("BLENDER_VIDEO_OK");
