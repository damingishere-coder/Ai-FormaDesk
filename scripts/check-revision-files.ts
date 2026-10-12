import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA } from "../server/config";
import { revisionResidue } from "../server/revision-files";

// Read-only: it also works while the backend owns the data directory.
const file = path.join(DATA, "index.sqlite");
if (!fs.existsSync(file)) throw new Error("当前数据目录没有作品索引，请设置 ZAOWU_DATA_DIR。");
const db = new Database(file, { readonly: true, fileMustExist: true });
try {
  db.pragma("query_only = ON");
  const committed = db.prepare("SELECT id FROM documents WHERE kind='revision'").all() as { id: string }[];
  const jobs = db.prepare("SELECT id FROM documents WHERE kind='job' AND json_extract(body,'$.status') IN ('queued','running')").all() as { id: string }[];
  console.log(JSON.stringify({ readOnly: true, entries: revisionResidue(new Set(committed.map(r => r.id)), new Set(jobs.map(j => j.id))) }, null, 2));
} finally { db.close(); }
