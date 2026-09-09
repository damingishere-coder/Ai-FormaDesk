import { afterAll, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
const pipeline = vi.hoisted(() => vi.fn());
vi.mock("../server/visual-pipeline", () => ({ runVisualPipeline: pipeline }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-visual-jobs-"));
process.env.ZAOWU_DATA_DIR = root;
const { db, put, uid, project, list, get } = await import("../server/store");
const { enqueue, cancel, retryJob, restore, artifactPath } =
  await import("../server/jobs");
const { uploadImage, collectUnusedImages } =
  await import("../server/attachments");
const { environment } = await import("../server/environment");
const { codex } = await import("../server/codex");
const empty = {
  objects: [],
  stats: { objects: 0, vertices: 0, triangles: 0 },
  units: "meters",
  coordinates: "blender-z-up",
};
const create = () =>
  put("project", {
    id: uid(),
    name: "测试",
    currentRevisionId: null,
    threadId: null,
    redo: ["keep-redo"],
    createdAt: new Date().toISOString(),
  });
async function input(pid: string) {
  return uploadImage(
    pid,
    await sharp({
      create: { width: 128, height: 128, channels: 3, background: "#abc" },
    })
      .png()
      .toBuffer(),
    "参考.png",
  );
}
async function done(id: string, status: string) {
  await vi.waitFor(() => expect(get<any>("job", id)?.status).toBe(status));
}
environment.codex = { ok: true };
environment.blender = { ok: true };
environment.sandbox = { ok: true };
afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
describe("视觉任务版本与自动运行", () => {
  it("明确建模自动入队，缺少附件引用时保留本轮参考；失败不发布", async () => {
    const p = create(),
      a = await input(p.id);
    pipeline.mockRejectedValueOnce(new Error("三视图不一致"));
    const spy = vi
      .spyOn(codex, "discuss")
      .mockResolvedValueOnce({
        reply: "开始",
        buildNow: true,
        proposal: {
          title: "按图建模",
          description: "还原盒子",
          attachmentIds: [],
        },
      });
    const j = enqueue(p.id, null, "discuss", {
      prompt: "按图建模",
      attachmentIds: [a.id],
    });
    await done(j.id, "succeeded");
    await vi.waitFor(() =>
      expect(
        list<any>("job", p.id).filter((j) => j.type === "generate"),
      ).toHaveLength(1),
    );
    const next = list<any>("job", p.id).find((j) => j.type === "generate");
    await done(next.id, "failed");
    expect(next.request.attachmentIds).toEqual([a.id]);
    expect(list("revision", p.id)).toHaveLength(0);
    expect(project(p.id).redo).toEqual(["keep-redo"]);
    spy.mockRestore();
  });
  it("取消阻止晚到结果发布，重试沿用输入和 runId，成功证据随版本归档并能撤销", async () => {
    const p = create(),
      a = await input(p.id);
    let finish!: () => void;
    pipeline.mockImplementationOnce(
      (o: any) =>
        new Promise((resolve) => {
          o.onState({
            runId: o.runId,
            phase: "生成三视图",
            assumptions: [],
            evidence: [],
            reviews: [],
          });
          finish = () =>
            resolve({ dir: o.root, scene: empty, summary: "late", state: {} });
        }),
    );
    const j = enqueue(p.id, null, "generate", {
      prompt: "按图建模",
      attachmentIds: [a.id],
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(get<any>("attachment", a.id).used).toBe(true);
    cancel(j.id);
    finish();
    await done(j.id, "cancelled");
    expect(list("revision", p.id)).toHaveLength(0);
    expect(project(p.id).redo).toEqual(["keep-redo"]);
    let runId = "";
    pipeline.mockImplementationOnce(async (o: any) => {
      runId = o.runId;
      fs.mkdirSync(o.root, { recursive: true });
      const source = path.join(o.root, "view.png");
      fs.copyFileSync(o.images[0], source);
      o.onState({
        runId: o.runId,
        phase: "检查通过",
        assumptions: [],
        reviews: [],
        evidence: [
          {
            artifactId: o.register(source, "正面参考图", "image/png"),
            label: "正面参考图",
            kind: "image",
          },
        ],
      });
      const json = Buffer.from(
        JSON.stringify({ asset: { version: "2.0" }, nodes: [] }).padEnd(
          52,
          " ",
        ),
      );
      const aligned = Buffer.concat([
        json,
        Buffer.alloc((4 - (json.length % 4)) % 4, 32),
      ]);
      const glb = Buffer.alloc(20 + aligned.length);
      glb.write("glTF");
      glb.writeUInt32LE(2, 4);
      glb.writeUInt32LE(glb.length, 8);
      glb.writeUInt32LE(aligned.length, 12);
      glb.writeUInt32LE(0x4e4f534a, 16);
      aligned.copy(glb, 20);
      fs.writeFileSync(path.join(o.root, "scene.glb"), glb);
      fs.writeFileSync(path.join(o.root, "scene.blend"), "BLENDER-test-only");
      fs.writeFileSync(path.join(o.root, "scene.json"), JSON.stringify(empty));
      fs.writeFileSync(path.join(o.root, "generated.py"), "# fixture");
      fs.writeFileSync(path.join(o.root, "execution.log"), "fixture");
      return { dir: o.root, scene: empty, summary: "检查通过", state: {} };
    });
    const retried = retryJob(j.id);
    await done(retried.id, "succeeded");
    expect(runId).toBe(j.id);
    const revision = list<any>("revision", p.id)[0];
    expect(project(p.id).currentRevisionId).toBe(revision.id);
    expect(project(p.id).redo).toEqual([]);
    const reference = artifactPath(revision.visual.evidence[0].artifactId);
    expect(reference).toContain(
      path.join("revisions", revision.id, "references"),
    );
    fs.rmSync(path.join(root, "jobs", j.id), { recursive: true, force: true });
    collectUnusedImages();
    expect(fs.existsSync(reference)).toBe(true);
    restore(p.id, revision.id, null, "undo");
    expect(project(p.id).currentRevisionId).toBeNull();
    restore(p.id, null, null, "redo");
    expect(project(p.id).currentRevisionId).toBe(revision.id);
  });
});
