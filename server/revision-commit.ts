import fs from "node:fs";
import path from "node:path";
import type { Job, Proposal, Revision, Scene } from "../src/types";
import { artifact, artifactPath } from "./artifacts";
import { archiveVisual } from "./visual-archive";
import { beginRevisionFiles, abortRevisionFiles, completeRevisionFiles } from "./revision-files";
import { db, put, get, uid, now, project, addMessage, invalidateProposals } from "./store";

/** Commit the authoritative files and core records together. No job event is published here. */
export function commitRevision(input: {
  job: Job;
  dir: string;
  scene: Scene;
  label: string;
  summary: string;
  proposalId?: string;
  signal: AbortSignal;
  completedJob: (revisionId: string) => Job;
}) {
  const { job, dir, scene, signal } = input;
  if (signal.aborted) throw new Error("任务已取消");
  if (project(job.projectId).currentRevisionId !== job.baseRevisionId)
    throw new Error("版本已变化，任务结果未覆盖当前项目");
  const rid = uid();
  const files = beginRevisionFiles(rid, job.projectId, job.id);
  let committed = false;
  try {
    const report = path.join(dir, "preview.json");
    const needsDetail = fs.existsSync(report) && !JSON.parse(fs.readFileSync(report, "utf8")).complete;
    const nextJob = input.completedJob(rid);
    const revision = db.transaction(() => {
      // Recheck at the commit boundary, independently of the executor's validation.
      if (signal.aborted) throw new Error("任务已取消");
      const current = project(job.projectId);
      if (current.currentRevisionId !== job.baseRevisionId)
        throw new Error("版本已变化，任务结果未覆盖当前项目");
      const artifacts = {} as Revision["artifacts"];
      for (const [key, name, mime] of [
        ["blend", "scene.blend", "application/x-blender"],
        ["glb", "scene.glb", "model/gltf-binary"],
        ["manifest", "scene.json", "application/json"],
        ["script", "generated.py", "text/x-python"],
        ["log", "execution.log", "text/plain"],
      ] as const) {
        const file = path.join(files.dir, name);
        fs.copyFileSync(path.join(dir, name), file);
        fs.chmodSync(file, 0o400);
        artifacts[key] = artifact(file, job.projectId, `Ai-FormaDesk-${rid}-${name}`, mime);
      }
      if (fs.existsSync(path.join(dir, "textures")))
        fs.cpSync(path.join(dir, "textures"), path.join(files.dir, "textures"), { recursive: true });
      const visual = job.visual
        ? archiveVisual(job.visual, files.dir, artifactPath, (f, name, mime) => artifact(f, job.projectId, name, mime))
        : undefined;
      const revision: Revision = {
        id: rid, projectId: job.projectId, parentId: job.baseRevisionId, source: job.type,
        label: input.label, createdAt: now(), scene, artifacts, visual,
        preview: { status: needsDetail ? "basic" : "ready" },
      };
      put("revision", revision);
      invalidateProposals(job.projectId);
      put("project", { ...current, currentRevisionId: rid, redo: [], updatedAt: now() });
      if (input.proposalId)
        put("proposal", { ...get<Proposal>("proposal", input.proposalId)!, status: "succeeded" });
      put("job", nextJob);
      if (["generate", "blender-edit"].includes(job.type)) addMessage(job.projectId, "assistant", input.summary);
      return revision;
    })();
    committed = true;
    try { completeRevisionFiles(files); }
    catch (error) {
      console.error("模型已保存，提交标记未清理", { jobId: job.id, revisionId: rid, code: (error as NodeJS.ErrnoException).code || "MARKER_CLEANUP_FAILED" });
    }
    return { revision, job: nextJob, needsDetail };
  } catch (error) {
    if (!committed) {
      try { abortRevisionFiles(files); }
      catch (cleanupError) {
        console.error("失败提交目录未清理", { jobId: job.id, revisionId: rid, code: (cleanupError as NodeJS.ErrnoException).code || "CLEANUP_FAILED" });
      }
    }
    throw error;
  }
}
