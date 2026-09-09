import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const run = vi.hoisted(() => vi.fn());
vi.mock("../server/sandbox", () => ({ runBlender: run }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-preview-jobs-"));
process.env.ZAOWU_DATA_DIR = root;
const { db, put, get, list, uid, project, revision } = await import("../server/store");
const { retryJob, enqueue, artifactPath } = await import("../server/jobs");
const { environment } = await import("../server/environment");
const { codex } = await import("../server/codex");
const empty = { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" };
environment.blender = environment.sandbox = { ok: true };
environment.codex = { ok: false, error: "AI is offline" };
function failedModel() {
  const pid = uid(), id = uid();
  put("project", { id: pid, name: "摩托", currentRevisionId: null, threadId: null, redo: [], createdAt: new Date().toISOString() });
  put("job", { id, projectId: pid, baseRevisionId: null, type: "generate", status: "failed", stage: "失败", request: { prompt: "摩托", attachmentIds: [], objectId: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const dir = path.join(root, "jobs", id, "attempt-0");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "raw.blend"), "BLENDER-original-model");
  fs.writeFileSync(path.join(dir, "generated.py"), "DO_NOT_EXECUTE");
  return { pid, id, dir };
}
function output(dir: string, pending = true) {
  fs.copyFileSync(path.join(dir, "raw.blend"), path.join(dir, "scene.blend"));
  fs.writeFileSync(path.join(dir, "scene.json"), JSON.stringify(empty));
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, nodes: [] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  fs.writeFileSync(path.join(dir, "scene.glb"), glb);
  fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify({ complete: !pending }));
  return { code: 0, stdout: "ok", stderr: "" };
}
async function terminal(id: string) {
  await vi.waitFor(() => expect(["succeeded", "failed", "cancelled"]).toContain(get<any>("job", id)?.status));
  return get<any>("job", id)!;
}
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
describe("基础预览与可恢复的细节任务", () => {
  it("AI 离线时复用 raw.blend，不再次建模；细节超时仍保留已保存版本和部分日志", async () => {
    const old = failedModel();
    const ai = vi.spyOn(codex, "generate");
    run.mockImplementationOnce(async (dir, args) => {
      expect(args).toContain("basic");
      expect(args).not.toContain("execute");
      return output(dir);
    });
    run.mockImplementationOnce(async (dir) => {
      expect(project(old.pid).currentRevisionId).toBeTruthy();
      fs.mkdirSync(path.join(dir, "textures"), { recursive: true });
      fs.writeFileSync(path.join(dir, "textures", "completed.png"), "cached");
      throw Object.assign(new Error("执行超时，任务进程已停止"), { stdout: "completed one map", stderr: "" });
    });
    const recovered = retryJob(old.id);
    const result = await terminal(recovered.id);
    expect(result.status).toBe("succeeded");
    const detail = list<any>("job", old.pid).find(j => j.type === "preview")!;
    expect((await terminal(detail.id)).status).toBe("failed");
    const saved = revision(project(old.pid).currentRevisionId!);
    expect(saved.preview?.status).toBe("failed");
    expect(fs.readFileSync(artifactPath(saved.artifacts.blend), "utf8")).toBe("BLENDER-original-model");
    expect(fs.existsSync(artifactPath(saved.artifacts.glb))).toBe(true);
    expect(fs.readFileSync(path.join(root, "jobs", detail.id, "attempt-0", "execution.log"), "utf8")).toContain("completed one map");
    expect(ai).not.toHaveBeenCalled();
    ai.mockRestore();
    run.mockImplementationOnce(async (dir) => {
      expect(fs.readFileSync(path.join(dir, "textures", "completed.png"), "utf8")).toBe("cached");
      return output(dir, false);
    });
    const continued = retryJob(detail.id);
    expect((await terminal(continued.id)).status).toBe("succeeded");
    expect(project(old.pid).currentRevisionId).toBe(saved.id);
    expect(revision(saved.id).artifacts.blend).toBe(saved.artifacts.blend);
    expect(revision(saved.id).artifacts.glb).not.toBe(saved.artifacts.glb);
    expect(revision(saved.id).preview?.status).toBe("ready");
  });
  it("晚到的细节结果不能覆盖已切换的版本", async () => {
    const old = failedModel();
    run.mockImplementationOnce(async dir => output(dir, false));
    const result = await terminal(retryJob(old.id).id);
    const r = revision(result.resultRevisionId);
    run.mockImplementationOnce(async dir => {
      put("project", { ...project(old.pid), currentRevisionId: null });
      return output(dir, false);
    });
    const detail = enqueue(old.pid, r.id, "preview", {});
    expect((await terminal(detail.id)).status).toBe("failed");
    expect(project(old.pid).currentRevisionId).toBeNull();
    expect(revision(r.id).artifacts.glb).toBe(r.artifacts.glb);
  });
  it("基础导出超时也保留模型下载和继续生成入口", async () => {
    const old = failedModel();
    run.mockRejectedValueOnce(new Error("执行超时"));
    const result = await terminal(retryJob(old.id).id);
    expect(result.status).toBe("failed");
    expect(result.recoverablePreview).toBe(true);
    expect(fs.readFileSync(artifactPath(result.savedBlendArtifactId), "utf8")).toBe("BLENDER-original-model");
    expect(project(old.pid).currentRevisionId).toBeNull();
  });
});
