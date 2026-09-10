import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { BLENDER } from "./config";
import { get, list, project, revision, activeJob, put } from "./store";
import { artifactPath, type Artifact } from "./jobs";
import type { ProjectFile, ProjectFileKind } from "../src/libraryTypes";
import type { Render, VideoRecord } from "../src/types";
export type LinkedFile = {
  id: string;
  projectId: string;
  artifactId: string;
  revisionId: string;
  kind: ProjectFileKind;
  name: string;
  createdAt: string;
};
const native = promisify(execFile);
export function projectFiles(pid: string): ProjectFile[] {
  const p = project(pid);
  const result: ProjectFile[] = [];
  function add(
    aid: string | undefined,
    kind: ProjectFileKind,
    rid: string | null,
    name: string,
    date: string,
  ) {
    if (!aid || result.some((f) => f.id === aid)) return;
    const a = get<Artifact>("artifact", aid);
    if (!a || a.projectId !== pid) return;
    let size = 0,
      available = false;
    try {
      size = fs.statSync(artifactPath(aid)).size;
      available = true;
    } catch {}
    result.push({
      id: aid,
      projectId: pid,
      revisionId: rid,
      kind,
      name,
      format: path
        .extname(a.name || a.path)
        .slice(1)
        .toUpperCase(),
      createdAt: date,
      url: `/api/artifacts/${aid}`,
      available,
      size,
      current: rid === p.currentRevisionId,
    });
  }
  if (p.currentRevisionId) {
    const r = revision(p.currentRevisionId);
    if (r.projectId !== pid) throw new Error("作品版本不匹配");
    add(
      r.artifacts?.blend,
      "model",
      r.id,
      "当前模型 · Blender 源文件",
      r.createdAt,
    );
    add(
      r.artifacts?.glb,
      "model",
      r.id,
      "当前模型 · 通用 3D 文件",
      r.createdAt,
    );
  }
  for (const r of list<Render>("render", pid).reverse())
    add(r.artifactId, "image", r.revisionId, "渲染图片", r.createdAt);
  for (const v of list<VideoRecord>("video", pid).reverse())
    if (v.status === "ready")
      add(v.artifactId, "video", v.revisionId, "动画视频", v.createdAt);
  for (const f of list<LinkedFile>("project-file", pid))
    add(f.artifactId, f.kind, f.revisionId, f.name, f.createdAt);
  return result;
}
export function ownedProjectFile(pid: string, id: string) {
  const file = projectFiles(pid).find((f) => f.id === id);
  if (!file)
    throw Object.assign(new Error("文件不属于此作品"), { statusCode: 404 });
  if (!file.available)
    throw Object.assign(new Error("文件已移动或缺失，请恢复原文件后重试"), {
      statusCode: 404,
    });
  return { file, path: artifactPath(id) };
}
export async function revealProjectFile(pid: string, id: string) {
  const target = ownedProjectFile(pid, id);
  await native("/usr/bin/open", ["-R", target.path]);
  return { revealed: true };
}
export async function openProjectFile(pid: string, id: string) {
  const target = ownedProjectFile(pid, id);
  if (activeJob(pid))
    throw Object.assign(new Error("作品正在处理，请完成当前任务后再打开"), {
      statusCode: 409,
    });
  if (target.file.format !== "BLEND")
    throw new Error("请在工作台预览或下载此文件");
  if (target.file.kind !== "model" && target.file.kind !== "animation")
    throw new Error("不支持打开此类型");
  // Opening a source file is independent of the optional workbench bridge.
  // A separate process preserves any unsaved scene in existing Blender windows.
  const child = spawn(BLENDER, ["--disable-autoexec", target.path], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  put("project", { ...project(pid), lastOpenedAt: new Date().toISOString() });
  return { opened: true, mode: target.file.kind, fileId: target.file.id };
}

export async function openProjectSource(pid: string) {
  const source = projectFiles(pid).find(
    (f) => f.kind === "model" && f.format === "BLEND" && f.current,
  );
  if (!source) throw new Error("此作品还没有 Blender 源文件，请先完成建模");
  return openProjectFile(pid, source.id);
}
