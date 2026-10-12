import fs from "node:fs";
import path from "node:path";
import { DATA } from "./config";
import { get, put, uid } from "./store";

export type Artifact = { id: string; projectId: string; path: string; name: string; mime: string };

export function artifact(file: string, projectId: string, name: string, mime: string) {
  const id = uid();
  put("artifact", { id, projectId, path: file, name, mime });
  return id;
}

export function artifactPath(id: string) {
  const entry = get<Artifact>("artifact", id);
  if (!entry) throw Object.assign(new Error("文件不存在"), { statusCode: 404 });
  const real = fs.realpathSync(entry.path);
  if (!real.startsWith(fs.realpathSync(DATA) + path.sep) || !fs.statSync(real).isFile())
    throw new Error("文件不在工作台目录中");
  return real;
}
