import fs from "node:fs";
import path from "node:path";
import { DATA, ROOT } from "./config";
import { get, put, uid, now, project, revision, activeJob } from "./store";
import { artifact, artifactPath } from "./jobs";
import { runBlender } from "./sandbox";
import {
  trajectorySchema,
  type VideoRecord,
  type Trajectory,
} from "../src/types";
export const videoUploads = new Set<string>();
export function ownedVideo(pid: string, id: string) {
  project(pid);
  const v = get<VideoRecord>("video", id);
  if (!v || v.projectId !== pid) throw new Error("视频不属于当前作品");
  return v;
}
export function videoDir(v: VideoRecord) {
  return path.join(DATA, "videos", v.projectId, v.id);
}
export function createVideo(pid: string, body: unknown) {
  const p = project(pid);
  const trajectory = trajectorySchema.parse(body);
  const r = revision(trajectory.baseRevisionId);
  if (r.projectId !== pid || p.currentRevisionId !== r.id || activeJob(pid))
    throw new Error("场景已变化或正在处理，请结束当前任务后再录制");
  const v: VideoRecord = {
    id: uid(),
    projectId: pid,
    revisionId: r.id,
    settings: trajectory.settings,
    createdAt: now(),
    duration: trajectory.samples.at(-1)!.time,
    status: "recorded",
    trajectory,
  };
  const dir = videoDir(v);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "trajectory.json"),
    JSON.stringify(trajectory),
  );
  return put("video", v);
}
export async function uploadVideo(pid: string, id: string, buffer: Buffer) {
  const v = ownedVideo(pid, id);
  if (v.status === "ready") return v;
  if (activeJob(pid) || videoUploads.has(pid))
    throw new Error("作品正在处理，请稍后重试上传");
  if (v.settings.mode !== "realtime")
    throw new Error("此记录只接受 Blender 渲染");
  const mp4 = buffer.length > 12 && buffer.subarray(4, 8).toString() === "ftyp",
    webm = buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!mp4 && !webm) throw new Error("不是有效 MP4 或 WebM 视频");
  videoUploads.add(pid);
  const dir = videoDir(v);
  try {
    fs.writeFileSync(path.join(dir, "upload.video"), buffer);
    const r = await runBlender(
      dir,
      ["--python", path.join(ROOT, "blender/video.py"), "--", "inspect", dir],
      undefined,
      30000,
    );
    if (r.code !== 0) throw new Error("视频无法解码，请重试录制");
    const meta = JSON.parse(
      fs.readFileSync(path.join(dir, "metadata.json"), "utf8"),
    );
    if (
      meta.width !== v.settings.width ||
      meta.height !== v.settings.height ||
      Math.abs(meta.duration - v.duration) > 2
    )
      throw new Error("视频与录制参数不一致");
    project(pid);
    const filename = `video.${mp4 ? "mp4" : "webm"}`;
    fs.renameSync(path.join(dir, "upload.video"), path.join(dir, filename));
    return put("video", {
      ...v,
      status: "ready",
      mime: mp4 ? "video/mp4" : "video/webm",
      artifactId: artifact(
        path.join(dir, filename),
        pid,
        `FormaDesk-${id}.${mp4 ? "mp4" : "webm"}`,
        mp4 ? "video/mp4" : "video/webm",
      ),
    });
  } finally {
    videoUploads.delete(pid);
    fs.rmSync(path.join(dir, "upload.video"), { force: true });
  }
}
export async function renderVideo(
  v: VideoRecord,
  signal: AbortSignal,
  onProgress: (v: {
    completed: number;
    total: number;
    remainingSeconds?: number;
  }) => void,
) {
  const dir = videoDir(v);
  if(!fs.existsSync(path.join(dir,"base.blend"))) fs.copyFileSync(
    artifactPath(revision(v.revisionId).artifacts.blend),
    path.join(dir, "base.blend"),
  );
  const timer = setInterval(() => {
    try {
      onProgress(
        JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8")),
      );
    } catch {}
  }, 1000);
  try {
    const result = await runBlender(
      dir,
      ["--python", path.join(ROOT, "blender/video.py"), "--", "render", dir],
      signal,
      2 * 60 * 60 * 1000,
      true,
    );
    fs.writeFileSync(
      path.join(dir, "execution.log"),
      result.stdout + "\n" + result.stderr,
    );
    if (result.code !== 0)
      throw new Error(result.stderr.slice(-2500) || "视频渲染失败");
    if (signal.aborted) throw new Error("已取消");
    const output = path.join(dir, "video.mp4");
    if (!fs.existsSync(output) || fs.statSync(output).size < 100)
      throw new Error("未生成有效视频");
    const artifactId = artifact(
      output,
      v.projectId,
      `FormaDesk-${v.id}.mp4`,
      "video/mp4",
    );
    const ready = put("video", {
      ...v,
      status: "ready" as const,
      mime: "video/mp4",
      artifactId,
    });
    fs.rmSync(path.join(dir, "frames"), { recursive: true, force: true });
    return ready;
  } finally {
    clearInterval(timer);
  }
}
