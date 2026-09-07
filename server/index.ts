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
  type Job,
  type Project,
  type Snapshot,
} from "../src/types";
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
app.setErrorHandler((err, req, reply) => {
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
app.get("/api/projects", async () => list<Project>("project"));
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
  put("project", { ...p, name });
  return project(p.id);
});
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
      render: latestRender(p.id),
      messages: list<any>("message", p.id),
    };
  },
);
app.post<{ Params: { id: string } }>(
  "/api/projects/:id/generate",
  async (req, reply) => {
    const b = z
      .object({
        baseRevisionId: z.string().uuid().nullable(),
        prompt: z.string().trim().min(1).max(10000),
        objectId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    return reply
      .code(202)
      .send(enqueue(req.params.id, b.baseRevisionId, "generate", b));
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
      .object({ baseRevisionId: z.string().uuid(), camera: cameraSchema })
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
    return reply.send(fs.createReadStream(p));
  },
);
if (fs.existsSync(path.join(ROOT, "dist")))
  await app.register(statics, { root: path.join(ROOT, "dist") });
else
  app.get("/", async (_, reply) =>
    reply
      .type("text/html")
      .send("<h1>Ai-FormaDesk</h1><p>请运行 npm run build，再启动服务。</p>"),
  );
reapInterruptedProcesses(path.join(DATA, "runtime-processes"));
recoverInterrupted();
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
