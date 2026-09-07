import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { Job, Snapshot } from "../src/types";
const base = process.env.FORMA_TEST_URL || "http://127.0.0.1:18877";
const evidence = path.resolve("data/v2-evidence");
fs.mkdirSync(evidence, { recursive: true });
const session = await fetch(base + "/api/session");
const { token } = await session.json();
const headers = {
  Cookie: session.headers.get("set-cookie")!.split(";")[0],
  "X-Forma-Session": token,
  "Content-Type": "application/json",
};
async function req(route: string, body?: unknown, method?: string) {
  const r = await fetch(base + "/api" + route, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const v = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(v)}`);
  return v;
}
async function settled(j: Job) {
  const start = Date.now();
  let stage = "";
  while (!["succeeded", "failed", "cancelled"].includes(j.status)) {
    if (stage !== j.stage) {
      stage = j.stage;
      console.log(j.type, stage);
    }
    if (Date.now() - start > 900000) throw new Error("task timed out");
    await new Promise((r) => setTimeout(r, 2000));
    j = await req(`/jobs/${j.id}`);
  }
  assert.equal(j.status, "succeeded", j.error || "failed");
  return j;
}
for (let i = 0; i < 60; i++) {
  const h = await req("/health");
  if (!h.checking) {
    assert(h.ok, JSON.stringify(h));
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const p = await req("/projects", { name: "多模态工作台 · 真实验收" });
fs.writeFileSync(path.join(evidence, "project.json"), JSON.stringify(p));
const reference = await sharp(
  Buffer.from(
    '<svg width="480" height="360"><rect width="480" height="360" fill="white"/><rect x="90" y="140" width="300" height="130" fill="#1267da"/><circle cx="240" cy="95" r="42" fill="#f3ce25"/><rect x="125" y="185" width="45" height="45" fill="#eb3028"/></svg>',
  ),
)
  .png()
  .toBuffer();
fs.writeFileSync(path.join(evidence, "reference.png"), reference);
const upload = await fetch(`${base}/api/projects/${p.id}/attachments`, {
  method: "POST",
  headers: {
    ...headers,
    "Content-Type": "application/octet-stream",
    "X-File-Name": "reference.png",
  },
  body: reference,
});
assert.equal(upload.status, 201);
const a = await upload.json();
await settled(
  await req(`/projects/${p.id}/discuss`, {
    baseRevisionId: null,
    prompt:
      "先描述这张参考图中的三种彩色形状和相对位置，然后问我一个建模问题。现在不要生成方案。",
    attachmentIds: [a.id],
  }),
);
let s: Snapshot = await req(`/projects/${p.id}/scene`);
assert.equal(s.project.currentRevisionId, null);
assert.match(s.messages.at(-1)!.text, /蓝/);
assert.match(s.messages.at(-1)!.text, /黄/);
assert.match(s.messages.at(-1)!.text, /红/);
await settled(
  await req(`/projects/${p.id}/discuss`, {
    baseRevisionId: null,
    prompt:
      "把蓝色矩形做成一个 2 米宽、0.8 米深、0.8 米高的蓝色盒子；红色正方形做成它正面的红色小方块；黄色圆形做成盒子上方的黄色球体。只要三个简单几何对象，不要地面和灯光对象。使用默认位置和材质，保留参考图颜色及关系。请直接整理可执行方案，并引用刚才的参考图。",
    attachmentIds: [],
  }),
);
s = await req(`/projects/${p.id}/scene`);
const proposal = s.proposals.find((p) => p.status === "ready")!;
assert(proposal);
assert(proposal.attachmentIds.includes(a.id));
assert.equal(s.revision, null);
let j = await req(`/projects/${p.id}/generate`, { proposalId: proposal.id });
const duplicate = await req(`/projects/${p.id}/generate`, {
  proposalId: proposal.id,
});
assert.equal(j.id, duplicate.id);
await settled(j);
s = await req(`/projects/${p.id}/scene`);
assert(s.revision);
assert(s.scene.objects.length >= 3);
fs.writeFileSync(
  path.join(evidence, "first-scene.json"),
  JSON.stringify(s, null, 2),
);
await settled(
  await req(`/projects/${p.id}/discuss`, {
    baseRevisionId: s.project.currentRevisionId,
    prompt:
      "保留所有物体位置、尺寸和其他颜色，仅将黄色球体改为绿色。直接给出修改方案。",
    attachmentIds: [],
  }),
);
s = await req(`/projects/${p.id}/scene`);
const edit = s.proposals.find((p) => p.status === "ready")!;
assert(edit);
await settled(await req(`/projects/${p.id}/generate`, { proposalId: edit.id }));
s = await req(`/projects/${p.id}/scene`);
const first: Snapshot = JSON.parse(
  fs.readFileSync(path.join(evidence, "first-scene.json"), "utf8"),
);
assert.equal(s.scene.objects.length, first.scene.objects.length);
const originalBall = first.scene.objects.find((o) => /球/.test(o.name))!;
assert.notEqual(
  s.scene.objects.find((o) => o.id === originalBall.id)?.material?.color,
  originalBall.material?.color,
);
for (const o of first.scene.objects)
  assert.deepEqual(
    s.scene.objects.find((n) => n.id === o.id)?.transform,
    o.transform,
  );
const camera = {
  position: [4, 3, 5],
  target: [0, 0.6, 0],
  up: [0, 1, 0],
  fov: 42,
  aspect: 1,
};
await settled(
  await req(`/projects/${p.id}/render`, {
    baseRevisionId: s.project.currentRevisionId,
    camera,
    settings: { width: 512, height: 512, transparent: true },
  }),
);
s = await req(`/projects/${p.id}/scene`);
const png = Buffer.from(
  await (
    await fetch(base + `/api/artifacts/${s.render!.artifactId}`, { headers })
  ).arrayBuffer(),
);
fs.writeFileSync(path.join(evidence, "transparent.png"), png);
const metadata = await sharp(png).metadata();
assert.equal(metadata.width, 512);
assert.equal(metadata.height, 512);
assert(metadata.hasAlpha);
const { data, info } = await sharp(png)
  .raw()
  .toBuffer({ resolveWithObject: true });
assert(
  data.some((v, i) => i % info.channels === info.channels - 1 && v === 0),
  "requires transparent pixels",
);
for (const k of ["blend", "glb"] as const) {
  const bytes = Buffer.from(
    await (
      await fetch(
        base + `/api/artifacts/${s.revision!.artifacts[k]}?download=1`,
        { headers },
      )
    ).arrayBuffer(),
  );
  fs.writeFileSync(path.join(evidence, `scene.${k}`), bytes);
  assert(bytes.length > 100);
}
fs.writeFileSync(
  path.join(evidence, "final-scene.json"),
  JSON.stringify(s, null, 2),
);
console.log(
  "V2_REAL_ACCEPTANCE_OK",
  JSON.stringify({
    projectId: p.id,
    revisionId: s.project.currentRevisionId,
    renderId: s.render!.id,
    images: [a.id],
    messages: s.messages.length,
  }),
);
