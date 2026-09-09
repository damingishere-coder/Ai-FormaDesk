import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ROOT, DATA, BLENDER } from "./config";
import {
  commandCode,
  captureCode,
  inspectCode,
  parseToolResult,
  sessionGuard,
  prepareCaptureCode,
} from "./blender-mcp-code";
import type { SceneCommand } from "../src/types";
import type { BlenderStatus } from "../src/blenderTypes";

type Session = {
  id: string;
  projectId: string;
  baseRevisionId: string;
  dir: string;
  port: number;
  child?: ChildProcess;
  client?: Client;
  transport?: StdioClientTransport;
  state: BlenderStatus["state"];
  error?: string;
  busy: boolean;
  queue?: Promise<void>;
};
const runtimeDir =
  process.env.ZAOWU_MCP_RUNTIME || path.join(ROOT, "data/blender-mcp-runtime");
const runtimeFile = path.join(runtimeDir, "runtime.json");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readRuntime() {
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
  if (
    runtime.version !== "1.9.1" ||
    runtime.commit !== "5f8ddaf6e987c4aa0c3467fcc548838b28f64477" ||
    !fs.existsSync(runtime.python) ||
    !fs.existsSync(runtime.addon)
  )
    throw new Error("Blender MCP 运行时不完整，请重新安装");
  const hash = createHash("sha256")
    .update(fs.readFileSync(runtime.addon))
    .digest("hex");
  if (
    hash !== "f43469c8518c7021e0060e32cfe52e3beb126b0f62fbae7293106642a3ebda89"
  )
    throw new Error("Blender MCP 插件版本已变化，请重新安装已验证版本");
  return runtime;
}
export class BlenderBridge {
  private session?: Session;
  private lastProbe = 0;
  private opening = false;
  private probe?: Promise<BlenderStatus>;
  private recoveryFile = path.join(
    DATA,
    "blender-sessions",
    "recoverable.json",
  );
  private activeFile = path.join(DATA, "blender-sessions", "active.json");
  constructor() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.activeFile, "utf8"));
      if (
        !/^[a-f0-9-]{36}$/.test(saved.id) ||
        !Number.isInteger(saved.port) ||
        saved.port < 1024 ||
        saved.port > 65535
      )
        return;
      this.session = {
        id: saved.id,
        projectId: saved.projectId,
        baseRevisionId: saved.baseRevisionId,
        port: saved.port,
        dir: path.join(DATA, "blender-sessions", saved.id),
        state: "disconnected",
        busy: false,
        error: "后台已重启，可重新连接原 Blender 工作副本",
      };
    } catch {}
  }
  private persist(s: Session) {
    const record = JSON.stringify({
      id: s.id,
      projectId: s.projectId,
      baseRevisionId: s.baseRevisionId,
      port: s.port,
    });
    fs.writeFileSync(this.activeFile + ".tmp", record);
    fs.renameSync(this.activeFile + ".tmp", this.activeFile);
  }
  async refreshStatus() {
    const s = this.session;
    if (
      !s ||
      s.busy ||
      s.state !== "connected" ||
      Date.now() - this.lastProbe < 5000
    )
      return this.status();
    if (this.probe) return this.probe;
    this.lastProbe = Date.now();
    this.probe = this.exclusive(s, () =>
      this.execute(s, sessionGuard(s.id) + "print('FORMA_RESULT:{}')"),
    )
      .then(() => this.status())
      .catch(() => {
        s.state = "disconnected";
        s.error = "Blender 当前场景无法读取，请重新连接核对";
        return this.status();
      })
      .finally(() => {
        this.probe = undefined;
      });
    return this.probe;
  }
  private recovered(): any[] {
    try {
      return JSON.parse(fs.readFileSync(this.recoveryFile, "utf8"));
    } catch {
      return [];
    }
  }
  private exclusive<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const run = (s.queue || Promise.resolve()).then(async () => {
      if (this.session !== s)
        throw new Error("Blender 连接已变化，请刷新后重试");
      s.busy = true;
      try {
        return await fn();
      } finally {
        s.busy = false;
      }
    });
    s.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }
  status(): BlenderStatus {
    const s = this.session;
    let installed = false;
    try {
      readRuntime();
      installed = true;
    } catch {}
    return {
      installed,
      recoverable: this.recovered(),
      connected: s?.state === "connected",
      state: s?.state || "closed",
      projectId: s?.projectId,
      baseRevisionId: s?.baseRevisionId,
      sessionId: s?.id,
      error: s?.error,
    };
  }
  matches(pid: string) {
    return this.session?.projectId === pid;
  }
  private current(pid: string, base?: string | null) {
    const s = this.session;
    if (!s || s.projectId !== pid)
      throw new Error("请先在 Blender 中打开此作品");
    if (base !== undefined && s.baseRevisionId !== base)
      throw Object.assign(
        new Error(
          "Blender 工作副本与网页版本不同，修改已保留；请先保存副本或重新打开当前版本",
        ),
        { statusCode: 409 },
      );
    return s;
  }
  assertReady(pid: string, base: string) {
    const s = this.current(pid, base);
    if (s.state !== "connected")
      throw new Error(s.error || "Blender 未连接，请先重新连接并读取场景");
  }
  async open(projectId: string, baseRevisionId: string, source: string) {
    if (this.opening) throw new Error("Blender 正在启动，请等待连接完成");
    this.opening = true;
    try {
      return await this.openSession(projectId, baseRevisionId, source);
    } finally {
      this.opening = false;
    }
  }
  private async openSession(
    projectId: string,
    baseRevisionId: string,
    source: string,
  ) {
    if (!fs.existsSync(runtimeFile))
      throw new Error("尚未安装 Blender MCP，请运行 npm run setup:blender-mcp");
    if (this.session) {
      if (
        this.session.projectId === projectId &&
        this.session.baseRevisionId === baseRevisionId
      )
        return this.reconnect(projectId);
      throw Object.assign(
        new Error(
          "已有 Blender 工作副本打开。请先同步或另存，再断开后打开其他作品。",
        ),
        { statusCode: 409 },
      );
    }
    const runtime = readRuntime();
    const id = randomUUID();
    const dir = path.join(DATA, "blender-sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(source, path.join(dir, "working.blend"));
    fs.chmodSync(path.join(dir, "working.blend"), 0o600);
    const s: Session = {
      id,
      projectId,
      baseRevisionId,
      dir,
      port: 0,
      state: "opening",
      busy: false,
    };
    this.session = s;
    this.persist(s);
    fs.writeFileSync(
      path.join(dir, "session.json"),
      JSON.stringify({ id, projectId, baseRevisionId, port: s.port }),
    );
    fs.writeFileSync(
      path.join(dir, "bootstrap.json"),
      JSON.stringify({ id, dir, port: s.port, addon: runtime.addon }),
    );
    const log = fs.openSync(path.join(dir, "blender.log"), "a", 0o600);
    s.child = spawn(
      BLENDER,
      [
        "--factory-startup",
        "--disable-autoexec",
        "--python",
        path.join(ROOT, "blender/mcp_bootstrap.py"),
        "--",
        path.join(dir, "bootstrap.json"),
      ],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dir,
          TMPDIR: dir,
          BLENDER_USER_RESOURCES: path.join(dir, "resources"),
          DISABLE_TELEMETRY: "true",
        },
      },
    );
    fs.closeSync(log);
    s.child.unref();
    s.child.once("error", (e) => {
      s.state = "disconnected";
      s.error = e.message;
    });
    s.child.once("exit", () => {
      s.state = "disconnected";
      s.error = "Blender 窗口已关闭；工作副本保存在本机";
      void s.client?.close();
    });
    try {
      const started = Date.now();
      while (!fs.existsSync(path.join(dir, "ready.json"))) {
        if (s.state === "disconnected") throw new Error(s.error);
        if (Date.now() - started > 45000)
          throw new Error("Blender 启动超过 45 秒；工作副本已保留，可重新连接");
        await delay(300);
      }
      s.port = JSON.parse(
        fs.readFileSync(path.join(dir, "ready.json"), "utf8"),
      ).port;
      this.persist(s);
      await this.connect(s);
      return this.status();
    } catch (e) {
      s.state = "disconnected";
      s.error = (e as Error).message;
      throw e;
    }
  }
  private connect(s: Session) {
    return this.exclusive(s, () => this.connectUnlocked(s));
  }
  private async connectUnlocked(s: Session) {
    const runtime = readRuntime();
    const installedVersion = execFileSync(
      runtime.python,
      [
        "-c",
        "import importlib.metadata;print(importlib.metadata.version('blender-mcp'))",
      ],
      { timeout: 10000, encoding: "utf8" },
    ).trim();
    if (installedVersion !== runtime.version)
      throw new Error("Blender MCP 服务版本已变化，请重新安装");
    await s.client?.close().catch(() => {});
    s.transport = new StdioClientTransport({
      command: runtime.python,
      args: ["-m", "blender_mcp.server"],
      cwd: runtimeDir,
      stderr: "pipe",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: s.dir,
        BLENDER_HOST: "127.0.0.1",
        BLENDER_PORT: String(s.port),
        DISABLE_TELEMETRY: "true",
        BLENDER_MCP_SAFE_MODE: "true",
      },
    });
    s.transport.stderr?.on("data", () => {});
    const client = new Client({ name: "forma-workbench", version: "1.0.0" });
    s.client = client;
    client.onclose = () => {
      if (s.client === client && s.state === "connected") {
        s.state = "disconnected";
        s.error = "MCP 连接已断开，请重新连接读取场景";
      }
    };
    await client.connect(s.transport, { timeout: 15000 });
    const list = await client.listTools();
    for (const name of [
      "get_scene_info",
      "get_viewport_screenshot",
      "execute_blender_code",
    ])
      if (!list.tools.some((t) => t.name === name))
        throw new Error(`MCP 缺少工具 ${name}`);
    await client.callTool(
      {
        name: "get_scene_info",
        arguments: { user_prompt: "连接工作台作品并读取场景" },
      },
      undefined,
      { timeout: 10000 },
    );
    await this.execute(s, inspectCode(s.id));
    s.state = "connected";
    s.error = undefined;
  }
  async reconnect(pid: string) {
    const s = this.current(pid);
    await this.connect(s);
    return this.status();
  }
  private async execute(s: Session, code: string, signal?: AbortSignal) {
    if (!s.client) throw new Error("MCP 未连接");
    const result = await s.client.callTool(
      {
        name: "execute_blender_code",
        arguments: { code, user_prompt: "执行工作台已请求的场景操作" },
      },
      undefined,
      { timeout: 30000, signal },
    );
    return parseToolResult(result);
  }
  async inspect(pid: string) {
    const s = this.current(pid);
    return this.exclusive(s, () => this.execute(s, inspectCode(s.id)));
  }
  async screenshot(pid: string) {
    const s = this.current(pid);
    return this.exclusive(s, async () => {
      await this.execute(s, inspectCode(s.id));
      const result: any = await s.client!.callTool(
        {
          name: "get_viewport_screenshot",
          arguments: { max_size: 1200, user_prompt: "查看当前作品" },
        },
        undefined,
        { timeout: 15000 },
      );
      const item = result.content?.find((c: any) => c.type === "image");
      if (!item) throw new Error("Blender 没有返回截图");
      return { bytes: Buffer.from(item.data, "base64"), mime: item.mimeType };
    });
  }
  async capture(
    pid: string,
    base: string,
    dir: string,
    signal: AbortSignal,
    command?: SceneCommand,
  ) {
    const s = this.current(pid, base);
    if (s.state !== "connected")
      throw new Error("请先重新连接并核对 Blender 场景，再执行或同步");
    return this.exclusive(s, async () => {
      try {
        if (signal.aborted) throw new Error("任务已取消");
        const before = await this.execute(s, inspectCode(s.id), signal);
        const script = command
          ? commandCode(s.id, command)
          : "# 用户在 Blender 中编辑，保存当前工作副本\n";
        if (command) {
          await this.execute(s, script, signal);
          const after = await this.execute(s, inspectCode(s.id), signal);
          const others = (objects: any[]) =>
            objects
              .filter((o) => o.id !== command.objectId)
              .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          if (JSON.stringify(others(before)) !== JSON.stringify(others(after)))
            throw new Error("局部修改改变了其他部件，候选保留但不会同步到网页");
        }
        await this.execute(
          s,
          captureCode(s.id, path.join(dir, "before-normalize.blend")),
          signal,
        );
        const objects = await this.execute(s, inspectCode(s.id), signal);
        await this.execute(
          s,
          prepareCaptureCode(s.id, objects, randomUUID),
          signal,
        );
        await this.execute(
          s,
          captureCode(s.id, path.join(dir, "raw.blend")),
          signal,
        );
        fs.writeFileSync(path.join(dir, "generated.py"), script);
        fs.writeFileSync(
          path.join(dir, "execution.log"),
          "Blender MCP captured actual scene\n",
        );
        return await this.execute(s, inspectCode(s.id), signal);
      } catch (e) {
        s.state = "uncertain";
        s.error =
          "操作中断，Blender 中可能已有修改。请重新连接查看实际场景，再同步；不会自动重放操作。";
        throw e;
      }
    });
  }
  failed(pid: string) {
    const s = this.session;
    if (s?.projectId === pid) {
      s.state = "uncertain";
      s.error =
        "修改或同步未完成，Blender 工作副本已保留。请重新连接查看实际场景，再同步；不会自动重放修改。";
    }
  }
  committed(pid: string, base: string, next: string) {
    const s = this.session;
    if (s?.projectId === pid && s.baseRevisionId === base) {
      s.baseRevisionId = next;
      try {
        this.persist(s);
        fs.writeFileSync(
          path.join(s.dir, "session.json"),
          JSON.stringify({
            id: s.id,
            projectId: pid,
            baseRevisionId: next,
            port: s.port,
          }),
        );
      } catch {
        s.error = "作品版本已保存，连接记录写入失败；请保留当前 Blender 窗口";
      }
    }
  }
  async disconnect(pid: string) {
    const s = this.current(pid);
    return this.exclusive(s, async () => {
      const saved = this.recovered().filter((r) => r.id !== s.id);
      saved.push({
        id: s.id,
        projectId: pid,
        baseRevisionId: s.baseRevisionId,
        port: s.port,
        disconnectedAt: new Date().toISOString(),
      });
      fs.writeFileSync(this.recoveryFile, JSON.stringify(saved));
      await s.client?.close();
      this.session = undefined;
      fs.rmSync(this.activeFile, { force: true });
      return this.status();
    });
  }
  async recover(pid: string, id: string) {
    if (this.session || this.opening)
      throw new Error("请先断开当前 Blender 连接");
    const records = this.recovered();
    const saved = records.find((r) => r.id === id && r.projectId === pid);
    if (!saved || !/^[a-f0-9-]{36}$/.test(saved.id))
      throw new Error("找不到可恢复的工作副本");
    const s: Session = {
      ...saved,
      dir: path.join(DATA, "blender-sessions", saved.id),
      state: "disconnected",
      busy: false,
    };
    this.session = s;
    this.persist(s);
    fs.writeFileSync(
      this.recoveryFile,
      JSON.stringify(records.filter((r) => r.id !== id)),
    );
    await this.connect(s);
    return this.status();
  }
  async close() {
    await this.session?.client?.close();
  }
}
export const blenderBridge = new BlenderBridge();
