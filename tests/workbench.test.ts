import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { renderSettingsSchema } from "../src/types";
// All storage tests use an isolated temporary directory, never the user's data.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forma-v2-test-"));
process.env.ZAOWU_DATA_DIR = directory;
const { db, put, uid, project, list, invalidateProposals, recoverInterrupted } =
  await import("../server/store");
const {
  uploadImage,
  validateAttachments,
  removeUnusedImage,
  collectUnusedImages,
} = await import("../server/attachments");
const { trashProject, purgeProject, projectLibrary } =
  await import("../server/projects");
const create = () =>
  put("project", {
    id: uid(),
    name: "测试作品",
    currentRevisionId: null,
    threadId: null,
    redo: [],
    createdAt: new Date().toISOString(),
  });
afterAll(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
describe("图片与作品边界", () => {
  it("真实解码，拒绝伪造格式、损坏图片和超像素输入", async () => {
    const p = create();
    const input = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#abcdef" },
    })
      .jpeg()
      .toBuffer();
    const a = await uploadImage(p.id, input, "参考.jpg");
    expect(a.width).toBe(8);
    expect(a.height).toBe(6);
    await expect(
      uploadImage(p.id, Buffer.from("not an image"), "fake.png"),
    ).rejects.toThrow("图片无法导入");
    await expect(
      uploadImage(p.id, input.subarray(0, input.length - 30), "truncated.jpg"),
    ).rejects.toThrow();
    const huge = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(uploadImage(p.id, huge, "huge.png")).rejects.toThrow();
  });
  it("禁止跨项目引用，限制数量及总大小，已发送图片不可删除", async () => {
    const p = create(),
      other = create();
    const a = await uploadImage(
      p.id,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#123" },
      })
        .png()
        .toBuffer(),
      "a.png",
    );
    expect(() => validateAttachments(other.id, [a.id])).toThrow(
      "不属于当前作品",
    );
    expect(() => validateAttachments(p.id, Array(7).fill(a.id))).toThrow();
    const ids = Array.from({ length: 5 }, () => {
      const id = uid();
      put("attachment", { ...a, id, size: 10 * 1024 * 1024 });
      fs.copyFileSync(
        path.join(directory, "attachments", p.id, a.id + ".png"),
        path.join(directory, "attachments", p.id, id + ".png"),
      );
      return id;
    });
    expect(() => validateAttachments(p.id, ids)).toThrow("40 MB");
    put("attachment", { ...a, used: true });
    expect(() => removeUnusedImage(p.id, a.id)).toThrow("已发送");
  });
  it("回收站可恢复且阻止活动任务删除，彻底清理不影响其他作品", async () => {
    const p = create(),
      other = create();
    const a = await uploadImage(
      p.id,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#123" },
      })
        .png()
        .toBuffer(),
      "a.png",
    );
    const job = put("job", { id: uid(), projectId: p.id, status: "running" });
    expect(() => trashProject(p.id)).toThrow("执行任务");
    put("job", { ...job, status: "succeeded" });
    trashProject(p.id);
    expect(() => project(p.id)).toThrow("回收站");
    expect(projectLibrary(true).some((n) => n.id === p.id)).toBe(true);
    expect(
      fs.existsSync(path.join(directory, "attachments", p.id, a.id + ".png")),
    ).toBe(true);
    trashProject(p.id, true);
    expect(project(p.id).deletedAt).toBeNull();
    expect(() => purgeProject(p.id)).toThrow("回收站");
    trashProject(p.id);
    purgeProject(p.id);
    expect(list<any>("attachment", p.id)).toHaveLength(0);
    expect(fs.existsSync(path.join(directory, "attachments", p.id))).toBe(
      false,
    );
    expect(project(other.id).name).toBe("测试作品");
  });
  it("清理失败保留重试状态，拒绝目录符号链接", () => {
    const p = create();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "forma-protected-"));
    fs.writeFileSync(path.join(outside, "keep"), "protected");
    fs.mkdirSync(path.join(directory, "attachments"), { recursive: true });
    fs.symlinkSync(outside, path.join(directory, "attachments", p.id));
    trashProject(p.id);
    expect(() => purgeProject(p.id)).toThrow("符号链接");
    expect(project(p.id, true).cleanupState).toBe("failed");
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe(
      "protected",
    );
    expect(() => trashProject(p.id, true)).toThrow("彻底清理");
    fs.unlinkSync(path.join(directory, "attachments", p.id));
    purgeProject(p.id);
    fs.rmSync(outside, { recursive: true });
  });
  it("旧方案失效、后台重启恢复失败状态及 24 小时孤立附件回收", async () => {
    const p = create();
    const proposal = put("proposal", {
      id: uid(),
      projectId: p.id,
      status: "ready",
    });
    invalidateProposals(p.id);
    expect(list<any>("proposal", p.id)[0].status).toBe("stale");
    put("proposal", { ...proposal, status: "running" });
    put("message", { id: uid(), projectId: p.id, status: "pending" });
    recoverInterrupted();
    expect(list<any>("proposal", p.id)[0].status).toBe("failed");
    expect(list<any>("message", p.id)[0].status).toBe("failed");
    const a = await uploadImage(
      p.id,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
      "old.png",
    );
    put("attachment", {
      ...a,
      createdAt: new Date(Date.now() - 86500000).toISOString(),
    });
    collectUnusedImages();
    expect(list<any>("attachment", p.id)).toHaveLength(0);
  });
  it("排队任务取消立即解锁方案，清理项目后队列不能复活记录", async () => {
    const { codex } = await import("../server/codex");
    const { environment } = await import("../server/environment");
    const { enqueue, cancel } = await import("../server/jobs");
    environment.codex = { ok: true };
    environment.blender = { ok: true };
    environment.sandbox = { ok: true };
    let release!: (value: { reply: string; proposal: null; buildNow: boolean }) => void;
    const mock = vi.spyOn(codex, "discuss").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const a = create(),
      b = create();
    const first = enqueue(a.id, null, "discuss", {
      prompt: "占用测试队列",
      attachmentIds: [],
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const proposal = put("proposal", {
      id: uid(),
      projectId: b.id,
      status: "ready",
    });
    const second = enqueue(b.id, null, "generate", {
      prompt: "queued",
      proposalId: proposal.id,
    });
    put("proposal", { ...proposal, status: "running", jobId: second.id });
    cancel(second.id);
    expect(list<any>("proposal", b.id)[0].status).toBe("failed");
    trashProject(b.id);
    purgeProject(b.id);
    release({ reply: "完成", proposal: null, buildNow: false });
    await vi.waitFor(() =>
      expect(
        list<any>("job", a.id).find((j) => j.id === first.id)?.status,
      ).toBe("succeeded"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const kind of ["job", "message", "proposal"])
      expect(list(kind, b.id)).toHaveLength(0);
    mock.mockRestore();
  });
  it("回收站中未发送的参考图片仍然保留", async () => {
    const p = create();
    const a = await uploadImage(
      p.id,
      await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
      "参考.png",
    );
    put("attachment", {
      ...a,
      createdAt: new Date(Date.now() - 86500000).toISOString(),
    });
    trashProject(p.id);
    collectUnusedImages();
    expect(list("attachment", p.id)).toHaveLength(1);
  });
  it("渲染参数兼容默认值并拒绝越界与小数", () => {
    expect(renderSettingsSchema.parse({})).toEqual({
      width: 1280,
      height: 720,
      transparent: false,
    });
    for (const width of [0, 255, 4097, 512.5])
      expect(renderSettingsSchema.safeParse({ width }).success).toBe(false);
  });
});

describe('视频文件随作品清理',()=>{
 it('保留回收站视频，清理失败可重试且不会触及其他作品',()=>{
  const p=create(),other=create();const root=path.join(directory,'videos',p.id),otherRoot=path.join(directory,'videos',other.id);fs.mkdirSync(root,{recursive:true});fs.mkdirSync(otherRoot,{recursive:true});fs.writeFileSync(path.join(root,'clip.mp4'),'owned-video');fs.writeFileSync(path.join(otherRoot,'keep.mp4'),'other-video');
  const vid=uid();put('video',{id:vid,projectId:p.id,artifactId:uid(),revisionId:uid(),status:'ready'});
  trashProject(p.id);expect(fs.existsSync(path.join(root,'clip.mp4'))).toBe(true);trashProject(p.id,true);expect(list('video',p.id)).toHaveLength(1);trashProject(p.id);
  const backup=root+'-retry';fs.renameSync(root,backup);fs.symlinkSync(otherRoot,root);
  expect(()=>purgeProject(p.id)).toThrow('清理未完成');expect(project(p.id,true).cleanupState).toBe('failed');expect(fs.existsSync(path.join(otherRoot,'keep.mp4'))).toBe(true);
  fs.unlinkSync(root);fs.renameSync(backup,root);purgeProject(p.id);expect(fs.existsSync(root)).toBe(false);expect(list('video',p.id)).toHaveLength(0);expect(fs.existsSync(path.join(otherRoot,'keep.mp4'))).toBe(true);
 });
});
