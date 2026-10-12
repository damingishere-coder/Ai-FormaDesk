import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA, acquireDataOwnership } from "./config";

const markerName = ".commit-pending.json";
const uuid = /^[a-f0-9-]{36}$/;
export type RevisionFiles = { id: string; dir: string; token: string };
type Marker = { version: 1; revisionId: string; projectId: string; jobId: string; token: string; createdAt: string };

function root() {
  const parent = path.join(DATA, "revisions");
  if (fs.existsSync(parent) && fs.realpathSync(parent) !== parent)
    throw new Error("版本目录不允许符号链接");
  return parent;
}
function ownDirectory(files: RevisionFiles) {
  if (!uuid.test(files.id) || files.dir !== path.join(root(), files.id) || fs.realpathSync(files.dir) !== files.dir)
    throw new Error("无法确认本次提交目录归属");
  const marker = JSON.parse(fs.readFileSync(path.join(files.dir, markerName), "utf8")) as Marker;
  if (marker.revisionId !== files.id || marker.token !== files.token)
    throw new Error("提交目录所有权已变化，未清理文件");
}

/** Reserve a new, private directory. The marker survives an abrupt process exit. */
export function beginRevisionFiles(id: string, projectId: string, jobId: string): RevisionFiles {
  acquireDataOwnership();
  if (![id, projectId, jobId].every(v => uuid.test(v))) throw new Error("提交 ID 无效");
  const parent = root();
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const files = { id, dir: path.join(parent, id), token: randomUUID() };
  fs.mkdirSync(files.dir, { mode: 0o700 }); // Never reuse an existing revision directory.
  try {
    const marker: Marker = { version: 1, revisionId: id, projectId, jobId, token: files.token, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(files.dir, markerName), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    return files;
  } catch (error) {
    // This newly reserved directory has not escaped this function yet.
    if (fs.realpathSync(files.dir) === files.dir) fs.rmSync(files.dir, { recursive: true, force: true });
    throw error;
  }
}
export function abortRevisionFiles(files: RevisionFiles) {
  acquireDataOwnership();
  ownDirectory(files);
  fs.rmSync(files.dir, { recursive: true, force: true });
}
export function completeRevisionFiles(files: RevisionFiles) {
  acquireDataOwnership();
  ownDirectory(files);
  fs.unlinkSync(path.join(files.dir, markerName));
}

/** Diagnostic only. Never remove an unknown directory or follow a symlink. */
export function revisionResidue(committed: ReadonlySet<string>, activeJobs: ReadonlySet<string>) {
  const parent = root();
  if (!fs.existsSync(parent)) return [];
  return fs.readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
    const dir = path.join(parent, entry.name);
    if (entry.isSymbolicLink()) return [{ revisionId: entry.name, state: "blocked-path" }];
    if (!entry.isDirectory()) return [];
    const file = path.join(dir, markerName);
    if (!fs.existsSync(file)) return committed.has(entry.name) ? [] : [{ revisionId: entry.name, state: "untracked" }];
    try {
      if (fs.realpathSync(file) !== file || fs.statSync(file).size > 4096) throw new Error("invalid marker");
      const marker = JSON.parse(fs.readFileSync(file, "utf8")) as Marker;
      if (marker.version !== 1 || marker.revisionId !== entry.name || !uuid.test(marker.projectId) || !uuid.test(marker.jobId)) throw new Error("invalid marker");
      return [{ revisionId: entry.name, projectId: marker.projectId, jobId: marker.jobId, state: committed.has(entry.name) ? "committed-marker" : activeJobs.has(marker.jobId) ? "active-record" : "interrupted" }];
    } catch {
      return [{ revisionId: entry.name, state: "invalid-marker" }];
    }
  });
}
