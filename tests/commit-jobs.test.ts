import { afterAll, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const run = vi.hoisted(() => vi.fn());
vi.mock("../server/sandbox", () => ({ runBlender: run }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-commit-jobs-"));
process.env.ZAOWU_DATA_DIR = root;
const { db, put, get, uid, project, revision, list } = await import("../server/store");
const { enqueue, retryJob, artifactPath } = await import("../server/jobs");
const { environment } = await import("../server/environment");
const { codex } = await import("../server/codex");
const scene = { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" };
function fixture() {
  environment.blender = environment.sandbox = environment.codex = { ok: true };
  const pid = uid();
  put("project", { id: pid, name: "isolated fixture", currentRevisionId: null, threadId: null, redo: [], createdAt: new Date().toISOString() });
  return pid;
}
function output(dir: string, pending: boolean) {
  if (!fs.existsSync(path.join(dir, "raw.blend")))
    fs.writeFileSync(path.join(dir, "raw.blend"), "BLENDER-fixture");
  fs.copyFileSync(path.join(dir, "raw.blend"), path.join(dir, "scene.blend"));
  fs.writeFileSync(path.join(dir, "scene.json"), JSON.stringify(scene));
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, nodes: [] }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF"); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  fs.writeFileSync(path.join(dir, "scene.glb"), glb);
  fs.writeFileSync(path.join(dir, "preview.json"), JSON.stringify({ complete: !pending }));
  return { code: 0, stdout: "ok", stderr: "" };
}
async function terminal(id: string) {
  await vi.waitFor(() => expect(["succeeded", "failed", "cancelled"]).toContain(get<any>("job", id)?.status));
  return get<any>("job", id);
}
afterEach(() => { vi.restoreAllMocks(); run.mockReset(); });
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it("模型已提交后环境变坏，主任务与方案保持成功，并可对保存版本继续预览", async () => {
  const pid = fixture(), proposalId = uid();
  put("proposal", { id: proposalId, projectId: pid, status: "running" });
  vi.spyOn(codex, "generate").mockResolvedValue({ python: "# fixture", summary: "saved fixture" });
  run.mockImplementation(async (dir: string) => {
    const result = output(dir, true);
    environment.blender = { ok: false };
    return result;
  });
  const job = enqueue(pid, null, "generate", { prompt: "fixture", attachmentIds: [], proposalId });
  expect((await terminal(job.id)).status).toBe("succeeded");
  const rid = project(pid).currentRevisionId!;
  expect(get<any>("job", job.id).resultRevisionId).toBe(rid);
  expect(get<any>("proposal", proposalId).status).toBe("succeeded");
  const detail = list<any>("job", pid).find(j => j.type === "preview");
  expect(detail.status).toBe("failed");
  expect(detail.baseRevisionId).toBe(rid);
  expect(revision(rid).preview).toMatchObject({ status: "failed", jobId: detail.id });
  expect(fs.readFileSync(artifactPath(revision(rid).artifacts.blend), "utf8")).toBe("BLENDER-fixture");
  environment.blender = { ok: true };
  run.mockImplementation(async (dir: string) => output(dir, false));
  const continued = await terminal(retryJob(detail.id).id);
  expect(continued.status, continued.error).toBe("succeeded");
  expect(project(pid).currentRevisionId).toBe(rid);
  expect(revision(rid).preview?.status).toBe("ready");
  expect(get<any>("job", job.id).status).toBe("succeeded");
});

it("提交前验证失败仍标记失败并保留原版本", async () => {
  const pid = fixture();
  vi.spyOn(codex, "generate").mockResolvedValue({ python: "# fixture", summary: "fixture" });
  run.mockRejectedValueOnce(new Error("validation failed"));
  const job = enqueue(pid, null, "generate", { prompt: "fixture", attachmentIds: [] });
  expect((await terminal(job.id)).status).toBe("failed");
  expect(project(pid).currentRevisionId).toBeNull();
  expect(list("revision", pid)).toHaveLength(0);
  expect(list<any>("job", pid).filter(j => j.type === "preview")).toHaveLength(0);
});
