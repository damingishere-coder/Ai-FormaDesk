import { afterAll, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const run = vi.hoisted(() => vi.fn());
vi.mock("../server/sandbox", () => ({ runBlender: run }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-commit-jobs-"));
process.env.ZAOWU_DATA_DIR = root;
const { db, put, get, uid, project, revision, list } = await import("../server/store");
const { enqueue, retryJob, artifactPath, jobEvents } = await import("../server/jobs");
const { environment } = await import("../server/environment");
const { codex } = await import("../server/codex");
const { trashProject, purgeProject } = await import("../server/projects");
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

it("复制中 ENOSPC 回滚索引并只清理本次目录，旧模型与其他作品不受影响", async () => {
  const pid = fixture(), other = fixture(), base = uid();
  const original = path.join(root, "original.blend");
  fs.writeFileSync(original, "BLENDER-original");
  const { artifact } = await import("../server/jobs");
  const blend = artifact(original, pid, "original.blend", "application/x-blender");
  put("revision", { id: base, projectId: pid, parentId: null, scene, artifacts: { blend } });
  put("project", { ...project(pid), currentRevisionId: base });
  const unrelated = path.join(root, "revisions", uid());
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, "keep"), "unrelated");
  const before = fs.readdirSync(path.join(root, "revisions")).sort();
  vi.spyOn(codex, "generate").mockResolvedValue({ python: "# fixture", summary: "fixture" });
  run.mockImplementation(async (dir: string) => output(dir, false));
  const copy = fs.copyFileSync;
  vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest, mode) => {
    if (String(dest).includes(path.join(root, "revisions")) && String(dest).endsWith("scene.json"))
      throw Object.assign(new Error("simulated ENOSPC"), { code: "ENOSPC" });
    return copy(src, dest, mode);
  });
  const job = enqueue(pid, base, "generate", { prompt: "fixture", attachmentIds: [] });
  const failed = await terminal(job.id);
  expect(failed.status).toBe("failed");
  expect(failed.resultRevisionId).toBeNull();
  expect(project(pid).currentRevisionId).toBe(base);
  expect(list("revision", pid)).toHaveLength(1);
  expect(fs.readdirSync(path.join(root, "revisions")).sort()).toEqual(before);
  expect(fs.readFileSync(original, "utf8")).toBe("BLENDER-original");
  trashProject(pid); purgeProject(pid);
  expect(fs.readFileSync(path.join(unrelated, "keep"), "utf8")).toBe("unrelated");
  expect(project(other).currentRevisionId).toBeNull();
});

it("最后的 SQLite 写入失败也补偿文件和结果指针，不留下虚假新版本", async () => {
  const pid = fixture();
  const before = fs.existsSync(path.join(root, "revisions")) ? fs.readdirSync(path.join(root, "revisions")) : [];
  vi.spyOn(codex, "generate").mockResolvedValue({ python: "# fixture", summary: "fixture" });
  run.mockImplementation(async (dir: string) => output(dir, false));
  db.exec(`CREATE TEMP TRIGGER reject_completed_job BEFORE INSERT ON documents
    WHEN NEW.kind='job' AND json_extract(NEW.body,'$.status')='succeeded'
    BEGIN SELECT RAISE(ABORT,'simulated final DB write failure'); END;`);
  try {
    const job = enqueue(pid, null, "generate", { prompt: "fixture", attachmentIds: [] });
    const failed = await terminal(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("DB write failure");
    expect(failed.resultRevisionId).toBeNull();
    expect(project(pid).currentRevisionId).toBeNull();
    expect(list("revision", pid)).toHaveLength(0);
    expect(fs.readdirSync(path.join(root, "revisions"))).toEqual(before);
  } finally { db.exec("DROP TRIGGER reject_completed_job"); }
});

it("成功 Job 写入后的消息失败，不会提前发送成功或失去基础模型恢复入口", async () => {
  const pid = fixture();
  const before = fs.readdirSync(path.join(root, "revisions")).sort();
  vi.spyOn(codex, "generate").mockResolvedValue({ python: "# fixture", summary: "fixture" });
  run.mockImplementation(async (dir: string) => output(dir, false));
  db.exec(`CREATE TEMP TRIGGER reject_completed_message BEFORE INSERT ON documents
    WHEN NEW.kind='message' AND json_extract(NEW.body,'$.role')='assistant'
    BEGIN SELECT RAISE(ABORT,'simulated message write failure'); END;`);
  const job = enqueue(pid, null, "generate", { prompt: "fixture", attachmentIds: [] });
  const events: any[] = [];
  const record = (event: any) => events.push(structuredClone(event));
  jobEvents.on(job.id, record);
  try {
    const failed = await terminal(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("message write failure");
    expect(events.some(e => e.status === "succeeded" || e.resultRevisionId)).toBe(false);
    expect(events.at(-1)?.status).toBe("failed");
    expect(project(pid).currentRevisionId).toBeNull();
    expect(list("revision", pid)).toHaveLength(0);
    expect(fs.readdirSync(path.join(root, "revisions")).sort()).toEqual(before);
    expect(failed.recoverablePreview).toBe(true);
    expect(fs.readFileSync(artifactPath(failed.savedBlendArtifactId), "utf8")).toBe("BLENDER-fixture");
  } finally {
    jobEvents.off(job.id, record);
    db.exec("DROP TRIGGER reject_completed_message");
  }
});
