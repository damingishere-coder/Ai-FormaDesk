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
const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
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
app.post("/api/health/recheck", async () => checkEnvironment());
app.get<{ Querystring: { trash?: string } }>("/api/projects", async (req) =>
  projectLibrary(req.query.trash === "1"),
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
  const { name } = z
    .object({ name: z.string().trim().min(1).max(80) })
    .parse(req.body);
  put("project", { ...p, name, updatedAt: now() });
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
    return reply
      .code(202)
      .send(enqueue(req.params.id, b.baseRevisionId, "command", b));
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
      reply.header("Content-Disposition", `attachment; filename="${a.name}"`);
    const size = fs.statSync(p).size;
    reply.header("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2]))
        return reply
          .code(416)
          .header("Content-Range", `bytes */${size}`)
          .send();
      const start = match[1]
        ? Number(match[1])
        : Math.max(0, size - Number(match[2]));
      const end = match[1]
        ? match[2]
          ? Math.min(size - 1, Number(match[2]))
          : size - 1
        : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return reply
          .code(416)
          .header("Content-Range", `bytes */${size}`)
          .send();
      return reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${size}`)
        .header("Content-Length", end - start + 1)
        .send(fs.createReadStream(p, { start, end }));
    }
    return reply.header("Content-Length", size).send(fs.createReadStream(p));
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
recoverInterrupted();
collectUnusedImages();
const attachmentSweep = setInterval(collectUnusedImages, 3600000);
attachmentSweep.unref();
await app.listen({ host: "127.0.0.1", port: PORT });
console.log(`Ai-FormaDesk: http://127.0.0.1:${PORT}`);
void checkEnvironment();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  cancelAll();
  codex.close();
  await app.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
