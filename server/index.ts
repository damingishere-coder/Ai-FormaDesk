import { projectFiles, revealProjectFile, openProjectFile, openProjectSource } from "./project-files";
import { startLibraryCache, writeLibraryCache, libraryToken } from "./library-cache";
import { blenderBridge } from "./blender-mcp";
import { createVideo, uploadVideo, ownedVideo, videoUploads } from "./videos";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import statics from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ROOT, PORT, DATA } from "./config";
import { checkEnvironment, environment } from "./environment";
import { codex } from "./codex";
import {
  put,
  get,
  list,
  uid,
  now,
  project,
  revision,
  activeJob,
  latestRender,
  recoverInterrupted,
} from "./store";
import {
  enqueue,
  cancel,
  cancelAll,
  retryJob,
  restore,
  jobEvents,
  artifactPath,
  type Artifact,
} from "./jobs";
import { reapInterruptedProcesses } from "./process";
import {
  commandSchema,
  cameraSchema,
  renderSettingsSchema,
  type Proposal,
  type Job,
  type Project,
  type Snapshot,
} from "../src/types";
import {
  uploadImage,
  attachmentPath,
  validateAttachments,
  removeUnusedImage,
  collectUnusedImages,
} from "./attachments";
import { projectLibrary, trashProject, purgeProject } from "./projects";
import { saveCover } from "./covers";
import { startTokenTracking } from "./token-usage";
const app = Fastify({ logger: false, bodyLimit: 256 * 1024, forceCloseConnections: true });
const desktopToken = process.env.ZAOWU_DESKTOP_TOKEN;
await app.register(cookie);
const session = randomBytes(32).toString("hex");
const allowedHosts = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.NODE_ENV !== "production"
    ? ["127.0.0.1:5173", "localhost:5173"]
    : []),
]);
app.addHook("onRequest", async (req, reply) => {
  // Blender is a local native client. It receives only the library routes;
  // normal desktop pages and all editing APIs retain the desktop token gate.
  const libraryNativeRequest = req.headers["x-forma-library"] === libraryToken &&
    !req.headers.origin && !req.headers["sec-fetch-site"] && req.method === "GET" &&
    ["/api/session", "/api/library"].includes(req.url);
  if (desktopToken && req.headers["x-forma-desktop"] !== desktopToken && !libraryNativeRequest)
    return reply.code(403).send({ error: "请在 Ai-FormaDesk 桌面应用中打开工作台" });
  if (desktopToken) reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (!allowedHosts.has(req.headers.host || ""))
    return reply.code(403).send({ error: "不允许的 Host" });
  const origin = req.headers.origin;
  if (origin && !Array.from(allowedHosts).some((h) => origin === `http://${h}`))
    return reply.code(403).send({ error: "不允许的网页来源" });
  if (req.headers["sec-fetch-site"] === "cross-site")
    return reply.code(403).send({ error: "不允许跨站访问本机工作台" });
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Frame-Options", "DENY");
  if (
    (req.routeOptions.url?.startsWith("/api/") ||
      req.url.startsWith("/api/")) &&
    req.routeOptions.url !== "/api/session"
  ) {
    if (req.cookies.forma_session !== session)
      return reply.code(401).send({ error: "本地会话已过期，请刷新网页" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-forma-session"] !== session
    )
      return reply.code(403).send({ error: "缺少本地会话校验" });
  }
});
app.setErrorHandler((err, _req, reply) => {
  reply
    .code(err instanceof z.ZodError ? 400 : (err as any).statusCode || 500)
    .send({
      error:
        err instanceof z.ZodError
          ? err.issues.map((i) => i.message).join("；")
          : (err as Error).message,
    });
});
app.get("/api/session", async (_, reply) => {
  reply
    .setCookie("forma_session", session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    })
    .header("Cache-Control", "no-store");
  return { token: session };
});
app.get("/api/health", async () => environment);
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/source", async req => openProjectSource(req.params.id));
app.get("/api/blender/status", async () => blenderBridge.refreshStatus());
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/open", async req => {
  const p = project(req.params.id);
  if (activeJob(p.id)) throw new Error("请等待当前任务完成后打开 Blender");
  if (!p.currentRevisionId) throw new Error("请先创建并保存作品");
  const opened = await blenderBridge.open(p.id, p.currentRevisionId, artifactPath(revision(p.currentRevisionId).artifacts.blend));
  put("project", { ...project(p.id), lastOpenedAt: new Date().toISOString() });
  return opened;
});
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/recover", async req => {
  project(req.params.id); if(activeJob(req.params.id)) throw new Error("请等待任务完成");
  const {sessionId}=z.object({sessionId:z.string().uuid()}).parse(req.body);return blenderBridge.recover(req.params.id,sessionId);
});
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/reconnect", async req => { project(req.params.id); return blenderBridge.reconnect(req.params.id); });
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/disconnect", async req => {
  project(req.params.id); if (activeJob(req.params.id)) throw new Error("请先等待任务完成"); return blenderBridge.disconnect(req.params.id);
});
app.get<{ Params: { id: string } }>("/api/projects/:id/blender/scene", async req => { project(req.params.id); return blenderBridge.inspect(req.params.id); });
app.get<{ Params: { id: string } }>("/api/projects/:id/blender/screenshot", async (req, reply) => {
  project(req.params.id); const image = await blenderBridge.screenshot(req.params.id); return reply.header("Cache-Control", "no-store").type(image.mime).send(image.bytes);
});
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/edit", async (req, reply) => {
  const b = z.object({baseRevisionId:z.string().uuid(),objectId:z.string().uuid(),prompt:z.string().trim().min(1).max(10000)}).parse(req.body);
  blenderBridge.assertReady(req.params.id, b.baseRevisionId);
  return reply.code(202).send(enqueue(req.params.id,b.baseRevisionId,"blender-edit",b));
});
app.post<{ Params: { id: string } }>("/api/projects/:id/blender/sync", async (req, reply) => {
  const { baseRevisionId } = z.object({baseRevisionId:z.string().uuid()}).parse(req.body);
  blenderBridge.assertReady(req.params.id, baseRevisionId);
  return reply.code(202).send(enqueue(req.params.id, baseRevisionId, "blender-sync", {}));
});

app.post("/api/health/recheck", async () => checkEnvironment());
app.get<{ Querystring: { trash?: string } }>("/api/projects", async (req) =>
  projectLibrary(req.query.trash === "1"),
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/cover",
  { bodyLimit: 4 * 1024 * 1024 },
  async (req) => {
    const body = z.object({ revisionId: z.string().uuid(), image: z.string().max(4 * 1024 * 1024), replace: z.boolean().optional() }).parse(req.body);
    return saveCover(z.string().uuid().parse(req.params.id), body.revisionId, body.image, body.replace);
  },
);
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/attachments",
  { bodyLimit: 10 * 1024 * 1024 },
  async (req, reply) => {
    if (!Buffer.isBuffer(req.body))
      return reply.code(400).send({ error: "需要图片文件" });
    const name = decodeURIComponent(
      String(req.headers["x-file-name"] || "参考图片"),
    );
    return reply
      .code(201)
      .send(await uploadImage(req.params.id, req.body, name));
  },
);
app.get<{ Params: { id: string; aid: string } }>(
  "/api/projects/:id/attachments/:aid",
  async (req, reply) => {
    project(req.params.id, true);
    return reply
      .type("image/png")
      .header("Cache-Control", "private, max-age=3600")
      .send(fs.createReadStream(attachmentPath(req.params.id, req.params.aid)));
  },
);
app.delete<{ Params: { id: string; aid: string } }>(
  "/api/projects/:id/attachments/:aid",
  async (req) => {
    project(req.params.id);
    removeUnusedImage(req.params.id, req.params.aid);
    return { deleted: true };
  },
);
app.post<{ Params: { id: string } }>("/api/projects/:id/trash", async (req) =>
  trashProject(req.params.id),
);
app.post<{ Params: { id: string } }>("/api/projects/:id/untrash", async (req) =>
  trashProject(req.params.id, true),
);
app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
  z.object({ confirm: z.literal(true) }).parse(req.body);
  return purgeProject(req.params.id);
});
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/discuss",
  async (req, reply) => {
    const b = z
      .object({
        baseRevisionId: z.string().uuid().nullable(),
        prompt: z.string().trim().max(10000),
        objectId: z.string().uuid().nullable().optional(),
        attachmentIds: z.array(z.string().uuid()).max(6).default([]),
      })
      .parse(req.body);
    if (!b.prompt && !b.attachmentIds.length)
      return reply.code(400).send({ error: "请输入想法或添加图片" });
    validateAttachments(req.params.id, b.attachmentIds);
    return reply
      .code(202)
      .send(enqueue(req.params.id, b.baseRevisionId, "discuss", b));
  },
);
app.get("/api/library", async () => writeLibraryCache());
app.post<{ Params: { id:string } }>("/api/projects/:id/opened", async req => {
  const p = project(req.params.id);
  return put("project", {...p, lastOpenedAt:now()});
});
app.get<{ Params: { id:string } }>("/api/projects/:id/files", async req => projectFiles(req.params.id));
app.post<{ Params: { id:string; fileId:string } }>("/api/projects/:id/files/:fileId/reveal", async req => revealProjectFile(req.params.id,req.params.fileId));
app.post<{ Params: { id:string; fileId:string } }>("/api/projects/:id/files/:fileId/open", async req => openProjectFile(req.params.id,req.params.fileId));

app.post("/api/projects", async (req) => {
  const { name } = z
    .object({ name: z.string().trim().min(1).max(80) })
    .parse(req.body);
  const p: Project = {
    id: uid(),
    name,
    currentRevisionId: null,
    threadId: null,
    createdAt: now(),
    redo: [],
  };
  put("project", p);
  return p;
});
app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
  const p = project(req.params.id);
  const patch = z.object({name:z.string().trim().min(1).max(80).optional(),favorite:z.boolean().optional()}).strict().parse(req.body);
  put("project", { ...p, ...patch, ...(patch.name !== undefined ? {updatedAt:now()} : {}) });
  return project(p.id);
});
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/videos",
  { bodyLimit: 2 * 1024 * 1024 },
  async (req) => createVideo(req.params.id, req.body),
);
app.post<{ Params: { id: string; videoId: string } }>(
  "/api/projects/:id/videos/:videoId/upload",
  { bodyLimit: 128 * 1024 * 1024 },
  async (req) =>
    uploadVideo(req.params.id, req.params.videoId, req.body as Buffer),
);
app.post<{ Params: { id: string; videoId: string } }>(
  "/api/projects/:id/videos/:videoId/render",
  async (req) => {
    const v = ownedVideo(req.params.id, req.params.videoId);
    if (v.settings.mode !== "blender" || v.status === "ready")
      throw new Error("该视频无需渲染");
    return enqueue(v.projectId, v.revisionId, "video", { videoId: v.id });
  },
);
app.get<{ Params: { id: string } }>(
  "/api/projects/:id/scene",
  async (req): Promise<Snapshot> => {
    const p = project(req.params.id);
    const r = p.currentRevisionId ? revision(p.currentRevisionId) : null;
    return {
      project: p,
      revision: r,
      scene: r?.scene || {
        objects: [],
        stats: { objects: 0, vertices: 0, triangles: 0 },
        units: "meters",
        coordinates: "blender-z-up",
      },
      previewUrl: r ? `/api/artifacts/${r.artifacts.glb}` : null,
      activeJob: activeJob(p.id),
      jobs: list<Job>("job", p.id),
      videos: list<any>("video", p.id),
      render: latestRender(p.id),
      messages: list<any>("message", p.id),
      proposals: list<Proposal>("proposal", p.id),
    };
  },
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/generate",
  async (req, reply) => {
    const input = z
      .union([
        z.object({ proposalId: z.string().uuid() }),
        z.object({
          baseRevisionId: z.string().uuid().nullable(),
          prompt: z.string().trim().min(1).max(10000),
          objectId: z.string().uuid().nullable().optional(),
          attachmentIds: z.array(z.string().uuid()).max(6).default([]),
        }),
      ])
      .parse(req.body);
    if ("proposalId" in input) {
      project(req.params.id);
      const proposal = get<Proposal>("proposal", input.proposalId);
      if (!proposal || proposal.projectId !== req.params.id)
        return reply.code(404).send({ error: "方案不存在" });
      if (proposal.jobId && ["running", "succeeded"].includes(proposal.status))
        return reply.code(202).send(get<Job>("job", proposal.jobId));
      if (!["ready", "failed"].includes(proposal.status))
        return reply
          .code(409)
          .send({ error: "方案已过期，请继续讨论以更新方案" });
      validateAttachments(req.params.id, proposal.attachmentIds);
      const j = enqueue(req.params.id, proposal.baseRevisionId, "generate", {
        baseRevisionId: proposal.baseRevisionId,
        prompt: proposal.description,
        objectId: proposal.objectId,
        attachmentIds: proposal.attachmentIds,
        proposalId: proposal.id,
      });
      put("proposal", { ...proposal, jobId: j.id, status: "running" });
      return reply.code(202).send(j);
    }
    return reply
      .code(202)
      .send(enqueue(req.params.id, input.baseRevisionId, "generate", input));
  },
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/commands",
  async (req, reply) => {
    const b = commandSchema.parse(req.body);
    const useMcp = blenderBridge.matches(req.params.id) && ["transform", "material"].includes(b.operation);
    if (useMcp) blenderBridge.assertReady(req.params.id, b.baseRevisionId);
    return reply
      .code(202)
      .send(enqueue(req.params.id, b.baseRevisionId, "command", useMcp ? { ...b, executor: "mcp" } : b));
  },
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/render",
  async (req, reply) => {
    const b = z
      .object({
        baseRevisionId: z.string().uuid(),
        camera: cameraSchema,
        settings: renderSettingsSchema.default({
          width: 1280,
          height: 720,
          transparent: false,
        }),
      })
      .parse(req.body);
    return reply
      .code(202)
      .send(enqueue(req.params.id, b.baseRevisionId, "render", b));
  },
);
app.get<{ Params: { id: string } }>(
  "/api/projects/:id/revisions",
  async (req) => {
    project(req.params.id);
    return list("revision", req.params.id);
  },
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/restore",
  async (req) => {
    const b = z
      .object({
        baseRevisionId: z.string().uuid().nullable(),
        revisionId: z.string().uuid().nullable().optional(),
        action: z.enum(["undo", "redo", "restore"]).default("restore"),
      })
      .parse(req.body);
    if (b.action === "restore" && !b.revisionId)
      throw new Error("请选择要恢复的版本");
    return restore(
      req.params.id,
      b.baseRevisionId,
      b.revisionId || null,
      b.action,
    );
  },
);
app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
  const j = get<Job>("job", req.params.id);
  if (!j) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
  return j;
});
app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) =>
  cancel(req.params.id),
);
app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req, reply) =>
  reply.code(202).send(retryJob(req.params.id)),
);
app.get<{ Params: { id: string } }>(
  "/api/jobs/:id/events",
  async (req, reply) => {
    const j = get<Job>("job", req.params.id);
    if (!j) return reply.code(404).send({ error: "任务不存在" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    let closed = false;
    const send = (v: Job) => {
      if (!closed) {
        reply.raw.write(`id: ${v.updatedAt}\ndata: ${JSON.stringify(v)}\n\n`);
        if (["succeeded", "failed", "cancelled"].includes(v.status))
          reply.raw.end();
      }
    };
    const tick = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15000);
    jobEvents.on(j.id, send);
    reply.raw.on("close", () => {
      closed = true;
      clearInterval(tick);
      jobEvents.off(j.id, send);
    });
    send(j);
  },
);
app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
  "/api/artifacts/:id",
  async (req, reply) => {
    const a = get<Artifact>("artifact", req.params.id);
    if (!a) return reply.code(404).send({ error: "文件不存在" });
    const p = artifactPath(a.id);
    reply
      .type(a.mime)
      .header("Cache-Control", "private, max-age=31536000, immutable");
    if (req.query.download)
      reply.header("Content-Disposition", `attachment; filename="download.${path.extname(a.name).slice(1)}"; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    const size=fs.statSync(p).size;
    reply.header('Accept-Ranges','bytes');
    const range=req.headers.range;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))return reply.code(416).header('Content-Range',`bytes */${size}`).send();
      const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
      const end=match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return reply.code(416).header('Content-Range',`bytes */${size}`).send();
      return reply.code(206).header('Content-Range',`bytes ${start}-${end}/${size}`).header('Content-Length',end-start+1).send(fs.createReadStream(p,{start,end}));
    }
    return reply.header('Content-Length',size).send(fs.createReadStream(p));
  },
);
const webRoot = process.env.ZAOWU_WEB_DIR || path.join(ROOT, "dist");
if (fs.existsSync(webRoot)) await app.register(statics, { root: webRoot });
else
  app.get("/", async (_, reply) =>
    reply
      .type("text/html")
      .send("<h1>Ai-FormaDesk</h1><p>请运行 npm run build，再启动服务。</p>"),
  );
reapInterruptedProcesses(path.join(DATA, "runtime-processes"));
startTokenTracking();
recoverInterrupted();
collectUnusedImages();
const attachmentSweep = setInterval(collectUnusedImages, 3600000);
attachmentSweep.unref();
await app.listen({ host: "127.0.0.1", port: PORT });
const address = app.server.address();
const actualPort = typeof address === "object" && address ? address.port : PORT;
allowedHosts.add(`127.0.0.1:${actualPort}`);
allowedHosts.add(`localhost:${actualPort}`);
const stopLibraryCache = startLibraryCache(actualPort);
console.log(`Ai-FormaDesk: http://127.0.0.1:${actualPort}`);
process.send?.({ type: "forma-ready", port: actualPort });
void checkEnvironment();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopLibraryCache();
  const shutdownDeadline = setTimeout(() => { reapInterruptedProcesses(path.join(DATA, "runtime-processes")); process.exit(0); }, 8000);
  shutdownDeadline.unref();
  cancelAll();
  codex.close();
  await blenderBridge.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (desktopToken) {
  process.on("message", (message: any) => { if (message?.type === "forma-stop") void stop(); });
  process.on("disconnect", () => { void stop(); });
}
