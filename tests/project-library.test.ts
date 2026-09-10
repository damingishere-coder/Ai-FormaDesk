import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterLibrary } from "../src/libraryTypes";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-library-"));
process.env.ZAOWU_DATA_DIR = root;
const { put, get, uid, db } = await import("../server/store");
const { projectFiles, ownedProjectFile } =
  await import("../server/project-files");
const { projectLibrary, trashProject } = await import("../server/projects");
const { writeLibraryCache } = await import("../server/library-cache");
const { artifact } = await import("../server/jobs");
afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
it("跨作品、路径穿越和缺失文件不能定位或打开；关联动画不改变原版本", () => {
  const pid = uid(),
    other = uid(),
    rid = uid();
  put("project", {
    id: pid,
    name: "第四个作品",
    currentRevisionId: rid,
    createdAt: "2026-09-09",
    redo: [],
    threadId: null,
  });
  put("project", {
    id: other,
    name: "另一个作品",
    currentRevisionId: null,
    createdAt: "2026-09-08",
    redo: [],
    threadId: null,
  });
  const blend = path.join(root, "model.blend");
  fs.writeFileSync(blend, "test");
  const aid = artifact(blend, pid, "模型.blend", "application/x-blender");
  put("revision", {
    id: rid,
    projectId: pid,
    createdAt: "2026-09-09",
    artifacts: { blend: aid },
  });
  const animation = path.join(root, "animation.blend");
  fs.writeFileSync(animation, "animation");
  const anim = artifact(animation, pid, "组装.blend", "application/x-blender");
  put("project-file", {
    id: uid(),
    projectId: pid,
    revisionId: rid,
    artifactId: anim,
    kind: "animation",
    name: "组装动画",
    createdAt: "2026-09-09",
  });
  expect(projectFiles(pid).map((f) => f.kind)).toEqual(["model", "animation"]);
  expect(ownedProjectFile(pid, anim).path).toBe(fs.realpathSync(animation));
  expect(() => ownedProjectFile(other, anim)).toThrow("不属于");
  expect(() => ownedProjectFile(pid, "../../etc/passwd")).toThrow("不属于");
  const escaped = path.join(root, "escape.blend");
  fs.symlinkSync("/etc/hosts", escaped);
  const bad = artifact(escaped, pid, "逃逸.blend", "application/x-blender");
  put("project-file", {
    id: uid(),
    projectId: pid,
    revisionId: rid,
    artifactId: bad,
    kind: "animation",
    name: "逃逸",
    createdAt: "2026-09-09",
  });
  expect(() => ownedProjectFile(pid, bad)).toThrow("缺失");
  fs.unlinkSync(animation);
  expect(projectFiles(pid).find((f) => f.id === anim)?.available).toBe(false);
  expect(() => ownedProjectFile(pid, anim)).toThrow("缺失");
  expect(get<any>("project", pid).currentRevisionId).toBe(rid);
  trashProject(pid);
  expect(() => ownedProjectFile(pid, aid)).toThrow("回收站");
});
it("收藏、中文搜索与排序兼容旧作品；缓存不含回收站作品或会话凭据", () => {
  const a = {
    id: uid(),
    name: "车辆 10",
    currentRevisionId: null,
    threadId: null,
    createdAt: "2026-09-01",
    redo: [],
  };
  const b = {
    ...a,
    id: uid(),
    name: "车辆 2",
    createdAt: "2026-09-03",
    favorite: true,
    lastOpenedAt: "2026-09-09",
  };
  put("project", a);
  put("project", b);
  expect(
    filterLibrary([a, b], "  车辆 ", false, "name").map((p) => p.name),
  ).toEqual(["车辆 2", "车辆 10"]);
  expect(filterLibrary([a, b], "", true, "created").map((p) => p.id)).toEqual([
    b.id,
  ]);
  expect(filterLibrary([a, b], "不存在", false, "updated")).toEqual([]);
  const removed = { ...a, id: uid(), name: "已移除作品" };
  put("project", removed);
  trashProject(removed.id);
  const cache = writeLibraryCache();
  expect(cache.projects.some((p) => p.id === removed.id)).toBe(false);
  expect(cache.projects.find((p) => p.id === b.id)?.favorite).toBe(true);
  expect(JSON.stringify(cache)).not.toMatch(/forma_session|"token"/);
  const connection = path.join(root, "project-library/connection.json");
  fs.chmodSync(connection, 0o644);
  writeLibraryCache();
  expect(fs.statSync(connection).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(connection)).mode & 0o777).toBe(0o700);
  expect(projectLibrary().find((p) => p.id === a.id)?.favorite).toBeUndefined();
});
