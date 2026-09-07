import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { BLENDER, ROOT, DATA } from "./config";
import { runProcess } from "./process";
import { IMAGE3D_RUNTIME, imagePython } from "./image3d";
export function sandboxProfile(jobDir: string, rendering = false) {
  const cachePaths: string[] = [];
  if (rendering) {
    const userCache = execFileSync(
      "/usr/bin/getconf",
      ["DARWIN_USER_CACHE_DIR"],
      { encoding: "utf8" },
    ).trim();
    // Metal's in-process compiler ignores HOME/TMPDIR. Only trusted rendering gets
    // its vendor-owned compiler cache; generated Python never receives this rule.
    for (const name of [
      "com.apple.metalfe",
      "com.apple.metal",
      "com.apple.gpuarchiver",
    ]) {
      const cache = path.join(userCache, "org.blenderfoundation.blender", name);
      fs.mkdirSync(cache, { recursive: true });
      cachePaths.push(fs.realpathSync(cache));
    }
  }

  const app = path.resolve(BLENDER, "../../..");
  const roots = [
    app,
    path.join(ROOT, "blender"),
    "/System",
    "/usr/lib",
    "/usr/share",
    "/Library/Apple",
    "/Library/Fonts",
    "/private/var/db/timezone",
  ];
  return `(version 1)
(deny default)
(allow process-fork process-exec signal sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm ipc-posix-sem)
(allow file-read-metadata)
; macOS 26 libignition opens / as its openat root (Apple dyld-support.sb).
(allow file-read* (literal "/"))
${roots.map((p) => `(allow file-read* file-map-executable (subpath ${JSON.stringify(p)}))`).join("\n")}
(allow file-read* file-write* (subpath ${JSON.stringify(fs.realpathSync(jobDir))}))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/dev/zero"))
(allow file-write* (literal "/dev/null"))
${cachePaths.map((p) => `(allow file-read* file-write* (subpath ${JSON.stringify(p)}))\n(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read-write") (subpath ${JSON.stringify(p)})))`).join("\n")}
${rendering ? `(allow file-issue-extension (require-all (extension-class "com.apple.app-sandbox.read") (subpath ${JSON.stringify(app)})))` : ""}
(allow iokit-open)
(deny network*)`;
}
let blenderQueue: Promise<unknown> = Promise.resolve();
export function runBlender(
  jobDir: string,
  args: string[],
  signal?: AbortSignal,
  timeout = 120000,
  rendering = false,
) {
  const queued = blenderQueue.then(async () => {
    if (signal?.aborted) throw new Error("任务已取消");
    const profile = path.join(jobDir, "sandbox.sb");
    fs.writeFileSync(
      profile,
      sandboxProfile(jobDir, rendering || args.includes("render")),
    );
    const tmp = path.join(jobDir, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    return runProcess(
      imagePython(),
      [
        path.join(ROOT, "scripts/image3d/resource_exec.py"),
        "--runtime", IMAGE3D_RUNTIME, "--", "/usr/bin/sandbox-exec",
        "-f",
        profile,
        BLENDER,
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--threads",
        "4",
        "--python-exit-code",
        "1",
        ...args,
      ],
      {
        cwd: jobDir,
        timeout,
        startTimeoutOnOutput: "FORMA_RESOURCE_ACQUIRED",
        signal,
        registryDir: path.join(DATA, "runtime-processes"),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: jobDir,
          TMPDIR: tmp + "/",
          LANG: "en_US.UTF-8",
          BLENDER_USER_RESOURCES: path.join(jobDir, "resources"),
          PYTHONNOUSERSITE: "1",
        },
      },
    );
  });
  blenderQueue = queued.catch(() => {});
  return queued;
}
