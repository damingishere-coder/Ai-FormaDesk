// Read only FormaDesk-owned session usage. Never copy messages or credentials.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { DATA } from "../server/config";
import { db, list } from "../server/store";
import { bindTokenThread, recordTokenTotal, projectTokenUsage } from "../server/token-usage";
import type { Project, Job } from "../src/types";

const apply = process.argv.includes("--apply");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const indexPath = path.join(codexHome, "state_5.sqlite");
if (!fs.existsSync(indexPath)) throw new Error("没有本机 Codex 会话索引，旧作品保持未统计");
const index = new Database(indexPath, { readonly: true, fileMustExist: true });
const projects = list<Project>("project");
const owners = new Map<string, string>();
const workspaces = new Map<string, string>();
for (const p of projects) {
  for (const id of [p.threadId, p.discussionThreadId]) if (id) owners.set(id, p.id);
  for (const kind of ["codex-workspaces", "discussion-workspaces"])
    workspaces.set(path.join(DATA, kind, p.id), p.id);
}
const jobs = new Map(list<Job>("job").map(j => [j.id, j.projectId]));
let recovered = 0;
try {
  const ids = [...owners.keys()];
  // Read metadata only; select transcripts only after proving the project association.
  const rows = index.prepare(`SELECT id, cwd, rollout_path FROM threads WHERE substr(cwd,1,?)=?${ids.length ? ` OR id IN (${ids.map(() => "?").join(",")})` : ""}`)
    .all(DATA.length + 1, DATA + path.sep, ...ids) as { id: string; cwd: string; rollout_path: string }[];
  for (const row of rows) {
    const relative = path.relative(path.join(DATA, "jobs"), row.cwd).split(path.sep);
    const projectId = owners.get(row.id) || workspaces.get(row.cwd) ||
      (relative.length > 1 && relative[0] !== ".." ? jobs.get(relative[0]) : undefined);
    if (!projectId || !projects.some(p => p.id === projectId) || !fs.existsSync(row.rollout_path)) continue;
    const file = fs.realpathSync(row.rollout_path);
    if (!["sessions", "archived_sessions"].some(dir => file.startsWith(path.join(codexHome, dir) + path.sep))) continue;
    let total: number | null = null;
    const lines = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"token_count"')) continue;
      try {
        const event = JSON.parse(line);
        if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
        const value = event.payload.info?.total_token_usage?.total_tokens;
        if (Number.isSafeInteger(value) && value >= 0) total = Math.max(total ?? 0, value);
      } catch { /* A partially written final line isn't usage evidence. */ }
    }
    if (total === null) continue;
    recovered++;
    if (apply) {
      bindTokenThread(projectId, row.id);
      recordTokenTotal(row.id, total);
    }
  }
  console.log(JSON.stringify({ applied: apply, recoveredThreads: recovered, projects: apply ? projects.map(p => ({ name: p.name, tokenUsage: projectTokenUsage(p) })) : undefined }, null, 2));
} finally {
  index.close();
  db.close();
}
