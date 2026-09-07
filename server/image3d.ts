import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DATA, ROOT } from "./config";
import { runProcess } from "./process";
import { attachmentPath, uploadImage } from "./attachments";
import { get, now, project, put, uid } from "./store";
import type { Attachment, PreparedImage } from "../src/types";

export const IMAGE3D_RUNTIME = path.resolve(
  process.env.FORMA_IMAGE3D_RUNTIME || path.join(DATA, "image3d-runtime"),
);
export const imagePython = () =>
  fs.existsSync(path.join(IMAGE3D_RUNTIME, "comfy-venv/bin/python"))
    ? path.join(IMAGE3D_RUNTIME, "comfy-venv/bin/python")
    : "/usr/bin/python3";

export async function imageEnvironment() {
  try {
    const result = await runProcess(imagePython(), [
      path.join(ROOT, "scripts/image3d/health.py"), "--runtime", IMAGE3D_RUNTIME,
    ], { timeout: 30000 });
    if (result.code) throw new Error(result.stderr || "本地引擎检查失败");
    return JSON.parse(result.stdout);
  } catch (error) {
    return { error: (error as Error).message, shape: { installationReady: false },
      texture: { installationReady: false } };
  }
}

export async function runImageProbe(
  dir: string, args: string[], signal: AbortSignal,
  progress: (report: any) => void,
) {
  let last = "";
  const inspect = () => {
    try {
      const value = fs.readFileSync(path.join(dir, "run.json"), "utf8");
      if (value !== last) { last = value; progress(JSON.parse(value)); }
    } catch { /* atomic report may not exist before preflight completes */ }
  };
  const timer = setInterval(inspect, 700);
  try {
    const result = await runProcess(imagePython(), [
      path.join(ROOT, "scripts/image3d/probe.py"), "--runtime", IMAGE3D_RUNTIME,
      "--job", dir, ...args,
    ], { signal, timeout: 24 * 3600_000, gracefulAbortMs: 7000 });
    fs.writeFileSync(path.join(dir, "supervisor.log"), result.stdout + "\n" + result.stderr);
    inspect();
    const report = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    if (result.code) throw new Error(report.error || "本地图生建模失败，已保留候选");
    return report;
  } finally { clearInterval(timer); inspect(); }
}

async function derived(pid: string, input: Buffer, name: string) {
  const a = await uploadImage(pid, input, name);
  put("attachment", { ...a, used: true });
  return a;
}

export function preparedImage(pid: string, id: string) {
  project(pid);
  const value = get<PreparedImage>("prepared-image", id);
  if (!value || value.projectId !== pid) throw new Error("处理图片不属于当前作品");
  for (const aid of [value.attachmentId, value.sourceId, value.imageId, value.maskId])
    attachmentPath(pid, aid);
  return value;
}

export async function prepareImage(
  pid: string, aid: string, dir: string, signal: AbortSignal,
  progress: (report: any) => void,
) {
  const original = attachmentPath(pid, aid);
  put("attachment", { ...get<Attachment>("attachment", aid)!, used: true });
  // A bounded working image retains the original attachment and its metadata.
  const normalized = await sharp(original).resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const source = await derived(pid, normalized, "主体工作图");
  const variants: PreparedImage["variants"] = [];
  let warning: string | undefined;
  try {
    await runImageProbe(dir, ["--case", "foreground", "--image", attachmentPath(pid, source.id)], signal, progress);
    const instances = JSON.parse(fs.readFileSync(path.join(dir, "foreground/instances.json"), "utf8"));
    for (const item of instances.instances) {
      // Filenames originate from the fixed Vision executable, not the browser.
      const maskFile = path.join(dir, "foreground", path.basename(item.mask));
      const imageFile = path.join(dir, "foreground", path.basename(item.foreground));
      const mask = await derived(pid, fs.readFileSync(maskFile), "主体蒙版");
      const image = await derived(pid, fs.readFileSync(imageFile), "已分离主体");
      variants.push({ imageId: image.id, maskId: mask.id });
    }
  } catch (error) {
    if (signal.aborted) throw error;
    warning = "自动分离未完成，请涂选主体：" + (error as Error).message;
  }
  if (signal.aborted) throw new Error("任务已取消");
  if (!variants.length) {
    warning ||= "未找到可用主体，请在蒙版画布中涂选";
    const mask = await derived(pid, await sharp({ create: { width: source.width,
      height: source.height, channels: 3, background: "#000" } }).png().toBuffer(), "待选择蒙版");
    variants.push({ imageId: source.id, maskId: mask.id });
  }
  return put<PreparedImage>("prepared-image", { id: uid(), projectId: pid,
    attachmentId: aid, sourceId: source.id, ...variants[0], width: source.width,
    height: source.height, variants, createdAt: now(),
    status: warning || variants.length > 1 ? "needs-selection" : "ready", warning });
}

export async function savePreparedMask(pid: string, id: string, input: Buffer,
  crop?: { left: number; top: number; width: number; height: number }) {
  const old = preparedImage(pid, id);
  const decoder = sharp(input, { limitInputPixels: 2048 * 2048, failOn: "warning" });
  const meta = await decoder.metadata();
  if (meta.format !== "png" || meta.width !== old.width || meta.height !== old.height)
    throw new Error("蒙版必须与主体工作图尺寸一致");
  const region = crop || { left: 0, top: 0, width: old.width, height: old.height };
  if (Object.values(region).some(n => !Number.isInteger(n) || n < 0)
    || region.width < 1 || region.height < 1
    || region.left + region.width > old.width || region.top + region.height > old.height)
    throw new Error("裁切区域越界");
  const alpha = await decoder.removeAlpha().greyscale().extract(region).raw().toBuffer();
  if (!alpha.some(v => v > 0)) throw new Error("请至少选择一部分主体");
  const rgb = await sharp(attachmentPath(pid, old.sourceId)).removeAlpha().extract(region).png().toBuffer();
  const source = await derived(pid, rgb, "裁切工作图");
  const mask = await derived(pid, await sharp(alpha, { raw: { width: region.width,
    height: region.height, channels: 1 } }).png().toBuffer(), "修补蒙版");
  const image = await derived(pid, await sharp(rgb).joinChannel(alpha,
    { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer(), "已修补主体");
  // Immutable preparation: a queued job cannot have its input silently changed.
  return put<PreparedImage>("prepared-image", { ...old, id: uid(), sourceId: source.id,
    imageId: image.id, maskId: mask.id, width: region.width, height: region.height,
    variants: [{ imageId: image.id, maskId: mask.id }], status: "ready", warning: undefined, createdAt: now() });
}
