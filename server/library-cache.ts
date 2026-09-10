import os from "node:os";
import { randomBytes } from "node:crypto";
// A process-scoped capability, never sent in public library responses.
export const libraryToken = randomBytes(32).toString("hex");
import fs from "node:fs";
import path from "node:path";
import { DATA, ROOT, PORT } from "./config";
import { projectLibrary } from "./projects";
import { get, storeChanges } from "./store";
import { projectFiles } from "./project-files";
import { artifactPath, type Artifact } from "./jobs";
let activePort = PORT;
export function writeLibraryCache() {
  const dir = path.join(DATA, "project-library");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const projects = projectLibrary().map((p) => {
    const aid = p.coverUrl?.split("/").at(-1);
    const a = aid && get<Artifact>("artifact", aid);
    let coverPath: string | null = null;
    if (a && a.projectId === p.id) {
      try {
        coverPath = artifactPath(a.id);
      } catch {}
    }
    return {
      ...p,
      activeJob: p.activeJob
        ? { status: p.activeJob.status, stage: p.activeJob.stage }
        : null,
      coverPath,
      files: projectFiles(p.id).map((file) => {
        // Only publish validated local paths; the Blender home can open offline.
        let localPath: string | null = null;
        if (file.available) {
          try {
            localPath = artifactPath(file.id);
          } catch {}
        }
        return { ...file, localPath };
      }),
    };
  });
  const value = {
    version: 2,
    dataRoot: DATA,
    updatedAt: new Date().toISOString(),
    baseUrl: `http://127.0.0.1:${activePort}`,
    launcher: [
      process.env.ZAOWU_DESKTOP_APP,
      path.join(os.homedir(), "Applications/Ai-FormaDesk.app"),
      "/Applications/Ai-FormaDesk.app",
    ].find((candidate) => candidate && fs.existsSync(candidate)) || path.join(ROOT, "启动 Ai-FormaDesk.command"),
    projects,
  };
  function writePrivate(name: string, data: unknown) {
    const temp = path.join(dir, `${name}.${randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path.join(dir, name));
  }
  writePrivate("connection.json", { baseUrl: value.baseUrl, launcher: value.launcher, token: libraryToken });
  writePrivate("index.json", value);
  return value;
}
export function startLibraryCache(port = PORT) {
  activePort = port;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function update(kind: string) {
    if (
      ![
        "project",
        "token-usage",
        "job",
        "revision",
        "render",
        "video",
        "project-file",
        "cover",
      ].includes(kind)
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        writeLibraryCache();
      } catch (error) {
        console.error("作品列表缓存更新失败:", (error as Error).message);
      }
    }, 250);
    timer.unref();
  }
  writeLibraryCache();
  storeChanges.on("change", update);
  return () => {
    clearTimeout(timer);
    storeChanges.off("change", update);
  };
}
