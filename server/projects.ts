import { blenderBridge } from "./blender-mcp";
import { videoUploads } from "./videos";
import { savedCover } from "./covers";
import { projectTokenUsage } from "./token-usage";
import fs from "node:fs";
import path from "node:path";
import { DATA } from "./config";
import {
  activeJob,
  db,
  invalidateProposals,
  list,
  now,
  project,
  put,
  storeChanges,
} from "./store";
import type { Job, Project, Revision, Render } from "../src/types";

export function projectLibrary(trash = false) {
  return list<Project>("project")
    .filter((p) => !!p.deletedAt === trash)
    .map((p) => {
      const revisions = list<Revision>("revision", p.id);
      const render = list<Render>("render", p.id).reverse().find((r) => r.revisionId === p.currentRevisionId);
      return {
        ...p,
        tokenUsage: projectTokenUsage(p),
        updatedAt: p.updatedAt || revisions.at(-1)?.createdAt || p.createdAt,
        activeJob: activeJob(p.id),
        coverRefreshSupported: true,
        coverUrl:
          savedCover(p.id, p.currentRevisionId) ||
          (render?.revisionId === p.currentRevisionId
            ? `/api/artifacts/${render.artifactId}`
            : null),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function trashProject(id: string, restore = false) {
  const p = project(id, true);
  if (blenderBridge.matches(id)) throw new Error("请先同步或另存 Blender 修改并断开连接，再移除作品");
  if (activeJob(id) || videoUploads.has(id))
    throw Object.assign(new Error("作品正在执行任务，请先等待完成或停止任务"), {
      statusCode: 409,
    });
  if (p.cleanupState)
    throw Object.assign(new Error("作品已开始彻底清理，只能重试清理"), {
      statusCode: 409,
    });
  invalidateProposals(id);
  return put("project", {
    ...p,
    deletedAt: restore ? null : now(),
    updatedAt: now(),
  });
}
export function purgeProject(id: string) {
  const p = project(id, true);
  if (blenderBridge.matches(id)) throw new Error("请先同步或另存 Blender 修改并断开连接，再移除作品");
  if (!p.deletedAt || activeJob(id) || videoUploads.has(id))
    throw Object.assign(new Error("请先将空闲作品移入回收站"), {
      statusCode: 409,
    });
  put("project", { ...p, cleanupState: "pending" });
  try {
    const paths = [
      ...list<Revision>("revision", id).map((r) => ["revisions", r.id]),
      ...list<Job>("job", id).map((j) => ["jobs", j.id]),
      ["attachments", id],
      ["videos", id],
      ["project-files", id],
      ["covers", id],
      ["codex-workspaces", id],
      ["discussion-workspaces", id],
    ];
    // Derive paths from owned records, never from arbitrary artifact paths. Validate every path before removal.
    const dirs = paths.map(([kind, key]) => {
      if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("清理记录的 ID 无效");
      const parent = path.join(DATA, kind),
        dir = path.join(parent, key);
      if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent)
        throw new Error("清理目录不允许符号链接");
      if (fs.existsSync(dir) && fs.realpathSync(dir) !== dir)
        throw new Error("作品目录不允许符号链接");
      return dir;
    });
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    db.transaction(() => {
      db.prepare("DELETE FROM documents WHERE projectId=?").run(id);
      db.prepare("DELETE FROM documents WHERE kind='project' AND id=?").run(id);
    })();
    storeChanges.emit("change", "project");
    return { deleted: true };
  } catch (e) {
    put("project", { ...p, cleanupState: "failed" });
    throw new Error("清理未完成，可重试：" + (e as Error).message);
  }
}
