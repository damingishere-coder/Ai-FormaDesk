import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DATA } from "./config";
import { db, get, list, now, project, put, uid } from "./store";
import type { Attachment } from "../src/types";

export function attachmentPath(pid: string, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(pid))
    throw new Error("图片 ID 无效");
  const a = get<Attachment>("attachment", id);
  if (!a || a.projectId !== pid)
    throw Object.assign(new Error("图片不存在或不属于当前作品"), {
      statusCode: 400,
    });
  const file = path.join(DATA, "attachments", pid, id + ".png");
  if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile())
    throw new Error("图片路径无效");
  return file;
}
export async function uploadImage(pid: string, input: Buffer, name: string) {
  project(pid);
  if (!input.length || input.length > 10 * 1024 * 1024)
    throw Object.assign(new Error("单张图片不能超过 10 MB"), {
      statusCode: 413,
    });
  try {
    const decoder = sharp(input, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    });
    const meta = await decoder.metadata();
    if (
      !["png", "jpeg", "webp"].includes(meta.format || "") ||
      (meta.pages || 1) > 1
    )
      throw new Error("仅支持静态 PNG、JPEG、WebP 图片");
    // Full decode rejects damaged inputs; normalized PNG strips private metadata and fixes orientation.
    const { data, info } = await decoder
      .rotate()
      .png()
      .toBuffer({ resolveWithObject: true });
    project(pid); // A project can be trashed while decoding is in progress.
    const a: Attachment = {
      id: uid(),
      projectId: pid,
      name: name.slice(0, 180) || "参考图片",
      size: input.length,
      width: info.width,
      height: info.height,
      createdAt: now(),
      used: false,
    };
    const dir = path.join(DATA, "attachments", pid);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, a.id + ".png"), data, { mode: 0o600 });
    return put("attachment", a);
  } catch (e) {
    throw Object.assign(new Error("图片无法导入：" + (e as Error).message), {
      statusCode: 400,
    });
  }
}
export function validateAttachments(pid: string, ids: string[]) {
  if (ids.length > 6 || new Set(ids).size !== ids.length)
    throw new Error("每条消息最多 6 张不同图片");
  const images = ids.map((id) => {
    attachmentPath(pid, id);
    return get<Attachment>("attachment", id)!;
  });
  if (images.reduce((n, a) => n + a.size, 0) > 40 * 1024 * 1024)
    throw new Error("图片合计不能超过 40 MB");
  return images;
}
export function removeUnusedImage(pid: string, id: string) {
  const file = attachmentPath(pid, id);
  const a = get<Attachment>("attachment", id)!;
  if (a.used)
    throw Object.assign(new Error("已发送的图片随对话保留"), {
      statusCode: 409,
    });
  fs.rmSync(file, { force: true });
  db.prepare("DELETE FROM documents WHERE kind='attachment' AND id=?").run(id);
}
export function collectUnusedImages() {
  for (const a of list<Attachment>("attachment")) {
    if (
      !a.used &&
      !get<{ deletedAt?: string }>("project", a.projectId)?.deletedAt &&
      Date.now() - Date.parse(a.createdAt) > 86400000
    ) {
      try {
        removeUnusedImage(a.projectId, a.id);
      } catch {
        /* retry on the next sweep */
      }
    }
  }
}
