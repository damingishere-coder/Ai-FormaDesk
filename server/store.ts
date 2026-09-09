import Database from "better-sqlite3";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA } from "./config";
import type {
  Project,
  Revision,
  Job,
  Render,
  Message,
  Proposal,
} from "../src/types";
export const db = new Database(path.join(DATA, "index.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(
  `CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,projectId TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));CREATE INDEX IF NOT EXISTS doc_project ON documents(kind,projectId);`,
);
export function put<T extends { id: string; projectId?: string }>(
  kind: string,
  v: T,
) {
  db.prepare(
    "INSERT INTO documents VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, projectId=excluded.projectId",
  ).run(kind, v.id, v.projectId || null, JSON.stringify(v));
  return v;
}
export function get<T>(kind: string, id: string): T | undefined {
  const r = db
    .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
    .get(kind, id) as { body: string } | undefined;
  return r ? JSON.parse(r.body) : undefined;
}
export function list<T>(kind: string, projectId?: string): T[] {
  const rows = projectId
    ? db
        .prepare(
          "SELECT body FROM documents WHERE kind=? AND projectId=? ORDER BY rowid",
        )
        .all(kind, projectId)
    : db
        .prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid")
        .all(kind);
  return (rows as { body: string }[]).map((r) => JSON.parse(r.body));
}
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function project(id: string, includeDeleted = false) {
  const p = get<Project>("project", id);
  if (!p) throw Object.assign(new Error("项目不存在"), { statusCode: 404 });
  if (!includeDeleted && p.deletedAt)
    throw Object.assign(new Error("作品已移入回收站，请先恢复"), {
      statusCode: 409,
    });
  return p;
}
export function revision(id: string) {
  const r = get<Revision>("revision", id);
  if (!r) throw Object.assign(new Error("版本不存在"), { statusCode: 404 });
  return r;
}
export function activeJob(pid: string, includePreview = true) {
  const jobs = list<Job>("job", pid);
  return (
    jobs.find(
      (j) => j.type !== "preview" && (j.status === "queued" || j.status === "running"),
    ) || (includePreview && jobs.find(
      (j) => j.status === "queued" || j.status === "running",
    )) || null
  );
}
export function addMessage(
  pid: string,
  role: string,
  text: string,
  extra: Partial<Message> = {},
) {
  return put<Message>("message", {
    id: uid(),
    projectId: pid,
    role,
    text,
    createdAt: now(),
    status: "completed",
    ...extra,
  });
}
export function invalidateProposals(pid: string) {
  for (const p of list<Proposal>("proposal", pid))
    if (p.status === "ready" || p.status === "failed")
      put("proposal", { ...p, status: "stale" });
}
export function latestRender(pid: string) {
  return list<Render>("render", pid).at(-1) || null;
}
export function recoverInterrupted() {
  for (const r of list<Revision>("revision"))
    if (r.preview?.status === "processing")
      put("revision", { ...r, preview: { ...r.preview, status: "failed", error: "后台已重启，基础预览保留，可继续生成细节。" } });
  for (const j of list<Job>("job"))
    if (["queued", "running"].includes(j.status))
      put("job", {
        ...j,
        status: "failed",
        stage: "执行中断",
        error: "后台已重新启动，未完成的任务已终止。已保存版本不受影响。",
        updatedAt: now(),
      } as Job);
  for (const m of list<Message>("message"))
    if (m.status === "pending")
      put("message", {
        ...m,
        status: "failed",
        text: "后台已重启，回复中断，请重新发送。",
      });
  for (const p of list<Proposal>("proposal"))
    if (p.status === "running") put("proposal", { ...p, status: "failed" });
}
