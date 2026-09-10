import { afterAll, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const { spawn } = await import("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-source-open-"));
process.env.ZAOWU_DATA_DIR = root;
const { put, get, uid, db } = await import("../server/store");
const { artifact } = await import("../server/jobs");
const { openProjectSource, openProjectFile } = await import("../server/project-files");
const { blenderBridge } = await import("../server/blender-mcp");
const { writeLibraryCache } = await import("../server/library-cache");
function fixture(kind = "model") {
  const pid = uid(), rid = uid();
  put("project", { id: pid, name: "源文件验收", currentRevisionId: rid, createdAt: "2026-09-10", redo: [], threadId: null });
  const source = path.join(root, uid() + ".blend");
  fs.writeFileSync(source, "unchanged source");
  const aid = artifact(source, pid, "源文件.blend", "application/x-blender");
  put("revision", { id: rid, projectId: pid, artifacts: kind === "model" ? { blend: aid } : {}, createdAt: "2026-09-10" });
  if (kind === "animation") put("project-file", { id: uid(), projectId: pid, revisionId: rid, artifactId: aid, kind, name: "动画", createdAt: "2026-09-10" });
  return { pid, rid, aid, source };
}
function launch(error?: Error) {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => error ? child.emit("error", error) : child.emit("spawn"));
    return child as any;
  });
  return child;
}
afterEach(() => vi.restoreAllMocks());
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
it("联动副本被占用仍直接打开模型与动画源文件，不复制、不重连、不覆盖现有会话", async () => {
  const bridge = vi.spyOn(blenderBridge, "open").mockRejectedValue(new Error("已有 Blender 工作副本打开"));
  const before = blenderBridge.status();
  for (const kind of ["model", "animation"]) {
    const f = fixture(kind), child = launch();
    const result = kind === "model" ? await openProjectSource(f.pid) : await openProjectFile(f.pid, f.aid);
    expect(result).toEqual({ opened: true, mode: kind, fileId: f.aid });
    expect(spawn).toHaveBeenLastCalledWith(expect.any(String), ["--disable-autoexec", fs.realpathSync(f.source)], { detached: true, stdio: "ignore" });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(fs.readFileSync(f.source, "utf8")).toBe("unchanged source");
    expect(get<any>("project", f.pid).currentRevisionId).toBe(f.rid);
    expect(get<any>("project", f.pid).lastOpenedAt).toBeTruthy();
  }
  expect(bridge).not.toHaveBeenCalled();
  expect(blenderBridge.status()).toEqual(before);
  expect(fs.existsSync(path.join(root, "blender-sessions"))).toBe(false);
});
it("启动失败、缺失文件和后台处理均不能报告打开成功", async () => {
  const f = fixture();
  launch(new Error("Blender 启动失败"));
  await expect(openProjectSource(f.pid)).rejects.toThrow("启动失败");
  expect(get<any>("project", f.pid).lastOpenedAt).toBeUndefined();
  put("job", { id: uid(), projectId: f.pid, status: "running", createdAt: "2026-09-10" });
  await expect(openProjectSource(f.pid)).rejects.toThrow("正在处理");
  const missing = fixture(); fs.unlinkSync(missing.source);
  await expect(openProjectSource(missing.pid)).rejects.toThrow("缺失");
});
it("离线缓存提供校验过的源文件路径，符号链接越界不提供路径", () => {
  const f = fixture();
  const cache = writeLibraryCache();
  expect(cache.dataRoot).toBe(fs.realpathSync(root));
  expect(cache.projects.find(p => p.id === f.pid)?.files[0].localPath).toBe(fs.realpathSync(f.source));
  fs.unlinkSync(f.source); fs.symlinkSync("/etc/hosts", f.source);
  const blocked = writeLibraryCache().projects.find(p => p.id === f.pid)?.files[0];
  expect(blocked?.available).toBe(false);
  expect(blocked?.localPath).toBeNull();
});
