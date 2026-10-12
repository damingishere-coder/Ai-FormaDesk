import { afterAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-revision-files-"));
process.env.ZAOWU_DATA_DIR = root;
const { beginRevisionFiles, completeRevisionFiles, abortRevisionFiles, revisionResidue } = await import("../server/revision-files");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it("崩溃遗留可只读区分活动、已提交和中断，不删除任何文件", () => {
  const files = beginRevisionFiles(randomUUID(), randomUUID(), randomUUID());
  const marker = JSON.parse(fs.readFileSync(path.join(files.dir, ".commit-pending.json"), "utf8"));
  const before = fs.readFileSync(path.join(files.dir, ".commit-pending.json"), "utf8");
  expect(revisionResidue(new Set(), new Set([marker.jobId]))).toContainEqual(expect.objectContaining({ revisionId: files.id, state: "in-progress" }));
  expect(revisionResidue(new Set([files.id]), new Set())).toContainEqual(expect.objectContaining({ revisionId: files.id, state: "committed-marker" }));
  expect(revisionResidue(new Set(), new Set())).toContainEqual(expect.objectContaining({ revisionId: files.id, state: "interrupted" }));
  expect(fs.readFileSync(path.join(files.dir, ".commit-pending.json"), "utf8")).toBe(before);
  completeRevisionFiles(files);
  expect(revisionResidue(new Set([files.id]), new Set())).toEqual([]);
});
it("补偿只删除自身目录；未知目录、坏标记和符号链接只报告", () => {
  const files = beginRevisionFiles(randomUUID(), randomUUID(), randomUUID());
  abortRevisionFiles(files);
  expect(fs.existsSync(files.dir)).toBe(false);
  const unknown = path.join(root, "revisions", randomUUID());
  fs.mkdirSync(unknown);fs.writeFileSync(path.join(unknown, "keep"), "unchanged");
  const bad = beginRevisionFiles(randomUUID(), randomUUID(), randomUUID());
  fs.writeFileSync(path.join(bad.dir, ".commit-pending.json"), "{}");
  expect(() => abortRevisionFiles(bad)).toThrow("所有权");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "forma-revision-outside-"));
  fs.writeFileSync(path.join(outside, "keep"), "protected");
  fs.symlinkSync(outside, path.join(root, "revisions", randomUUID()));
  const states = revisionResidue(new Set(), new Set()).map(r => r.state);
  expect(states).toEqual(expect.arrayContaining(["untracked", "invalid-marker", "blocked-path"]));
  expect(fs.readFileSync(path.join(unknown, "keep"), "utf8")).toBe("unchanged");
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("protected");
  fs.rmSync(outside, { recursive: true, force: true });
});
it("禁止重用既有目录、路径穿越或符号链接父目录", () => {
  const files = beginRevisionFiles(randomUUID(), randomUUID(), randomUUID());
  expect(() => beginRevisionFiles(files.id, randomUUID(), randomUUID())).toThrow();
  expect(() => beginRevisionFiles("../outside", randomUUID(), randomUUID())).toThrow("ID");
  const parent = path.join(root, "revisions"), saved = parent + "-saved";
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "forma-revision-parent-"));
  fs.writeFileSync(path.join(outside, "keep"), "protected");
  fs.renameSync(parent, saved);fs.symlinkSync(outside, parent);
  try {
    expect(() => beginRevisionFiles(randomUUID(), randomUUID(), randomUUID())).toThrow("符号链接");
    expect(() => revisionResidue(new Set(), new Set())).toThrow("符号链接");
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("protected");
  } finally {
    fs.unlinkSync(parent);fs.renameSync(saved, parent);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("真实 SIGKILL 遗留标记可由只读命令识别，既不抢锁也不删除", async () => {
  const childData = fs.mkdtempSync(path.join(root, "crash-case-"));
  const code = `
    const { uid } = await import(${JSON.stringify(path.resolve("server/store.ts"))});
    const { beginRevisionFiles } = await import(${JSON.stringify(path.resolve("server/revision-files.ts"))});
    const files = beginRevisionFiles(uid(),uid(),uid());
    process.send({ id: files.id });
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: process.cwd(), env: { ...process.env, ZAOWU_DATA_DIR: childData },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let error = "";child.stderr!.on("data", b => error += b);
  const message = await new Promise<{ id: string }>((resolve, reject) => {
    child.once("message", v => resolve(v as { id: string }));
    child.once("error", reject);
    child.once("exit", () => reject(new Error(error || "fixture exited before ready")));
  });
  child.kill("SIGKILL");
  await new Promise(resolve => child.once("close", resolve));
  const marker = path.join(childData, "revisions", message.id, ".commit-pending.json");
  const contents = fs.readFileSync(marker, "utf8");
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-revision-files.ts"], {
    cwd: process.cwd(), env: { ...process.env, ZAOWU_DATA_DIR: childData }, encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ readOnly: true, entries: [{ revisionId: message.id, state: "interrupted" }] });
  expect(fs.readFileSync(marker, "utf8")).toBe(contents);
}, 15000);
