import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-covers-"));
process.env.ZAOWU_DATA_DIR = root;
const { put, get, uid, db } = await import("../server/store");
const { saveCover, savedCover } = await import("../server/covers");
const { projectLibrary, trashProject, purgeProject } =
  await import("../server/projects");
afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
it("封面按版本落盘、刷新列表和撤销后可读，且不改变作品版本", async () => {
  const pid = uid(),
    rid = uid(),
    next = uid();
  const p = {
    id: pid,
    name: "封面测试",
    currentRevisionId: rid,
    createdAt: "2026-09-08",
    redo: [],
  };
  put("project", p);
  put("revision", { id: rid, projectId: pid });
  put("revision", { id: next, projectId: pid });
  const image =
    "data:image/png;base64," +
    (
      await sharp({
        create: {
          width: 1280,
          height: 800,
          channels: 3,
          background: "#639f89",
        },
      })
        .png()
        .toBuffer()
    ).toString("base64");
  const first = await saveCover(pid, rid, image);
  expect(projectLibrary()[0].coverUrl).toBe(first.coverUrl);
  expect(get("project", pid)).toEqual(p);
  const artifact = get<any>("artifact", first.coverUrl.split("/").at(-1)!);
  expect(await sharp(artifact.path).metadata()).toMatchObject({
    width: 640,
    height: 400,
    format: "jpeg",
  });
  expect(await saveCover(pid, rid, image)).toEqual(first);
  const cover = get<any>("cover", rid);
  put("cover", { ...cover, styleVersion: 1 });
  expect(savedCover(pid, rid)).toBeNull();
  const refreshed = await saveCover(pid, rid, image);
  expect(refreshed.coverUrl).not.toBe(first.coverUrl);
  expect(fs.existsSync(artifact.path)).toBe(true);
  put("cover", cover);
  put("project", { ...p, currentRevisionId: next });
  expect(projectLibrary()[0].coverUrl).toBeNull();
  put("project", p);
  expect(projectLibrary()[0].coverUrl).toBe(first.coverUrl);
  const other = uid();
  put("project", { ...p, id: other, currentRevisionId: null });
  await expect(saveCover(other, rid, image)).rejects.toThrow("不属于");
  await expect(
    saveCover(pid, next, "data:image/png;base64,AAAA"),
  ).rejects.toThrow();
  expect(savedCover(pid, next)).toBeNull();
  trashProject(pid);
  expect(projectLibrary(true)[0].coverUrl).toBe(first.coverUrl);
  await expect(saveCover(pid, next, image)).rejects.toThrow("回收站");
  trashProject(pid, true);
  expect(projectLibrary().find((v) => v.id === pid)?.coverUrl).toBe(
    first.coverUrl,
  );
  fs.rmSync(artifact.path);
  expect(savedCover(pid, rid)).toBeNull();
  const repaired = await saveCover(pid, rid, image);
  expect(repaired.coverUrl).not.toBe(first.coverUrl);
  trashProject(pid);
  purgeProject(pid);
  expect(fs.existsSync(path.join(root, "covers", pid))).toBe(false);
  expect(savedCover(pid, rid)).toBeNull();
  expect(get("project", other)).toBeDefined();
});

it("刷新替换同版本封面并优先于旧渲染图，失败保留旧封面且不改变模型版本", async () => {
  const pid = uid(),
    rid = uid();
  const p = {
    id: pid,
    name: "刷新封面",
    currentRevisionId: rid,
    createdAt: "2026-09-10",
    redo: [],
  };
  put("project", p);
  put("revision", { id: rid, projectId: pid });
  const image = async (color: string) =>
    "data:image/png;base64," +
    (
      await sharp({
        create: { width: 640, height: 400, channels: 3, background: color },
      })
        .png()
        .toBuffer()
    ).toString("base64");
  const first = await saveCover(pid, rid, await image("#dd3333"));
  put("render", {
    id: uid(),
    projectId: pid,
    revisionId: rid,
    artifactId: "old-render",
    createdAt: "2026-09-10",
  });
  const second = await saveCover(pid, rid, await image("#3366cc"), true);
  expect(second.coverUrl).not.toBe(first.coverUrl);
  expect(projectLibrary().find((v) => v.id === pid)?.coverUrl).toBe(
    second.coverUrl,
  );
  const file = get<any>("artifact", second.coverUrl.split("/").at(-1)!);
  const pixels = await sharp(file.path).raw().toBuffer();
  expect(pixels[2]).toBeGreaterThan(pixels[0]);
  await expect(
    saveCover(pid, rid, "data:image/png;base64,AAAA", true),
  ).rejects.toThrow();
  expect(savedCover(pid, rid)).toBe(second.coverUrl);
  expect(get("project", pid)).toEqual(p);
  put("project", { ...p, currentRevisionId: uid() });
  await expect(
    saveCover(pid, rid, await image("#22cc22"), true),
  ).rejects.toThrow("版本已变化");
  expect(savedCover(pid, rid)).toBe(second.coverUrl);
});
