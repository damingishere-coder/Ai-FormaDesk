import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CODEX, DATA, MODEL, EFFORT } from "./config";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams";
import { runProcess } from "./process";
const response = z.object({
  python: z.string().min(1).max(150000),
  summary: z.string().min(1).max(5000),
});
const instructions = `你是 Ai-FormaDesk 的 Blender 4.5 LTS Python 建模器。只返回符合 JSON Schema 的 python 和简体中文 summary。不要执行工具、调用子代理、联网、读写文件、运行进程或导入外部资源。后台将执行脚本并保存。只用 bpy/math/mathutils/random 创建或修改场景；不保存、不导出、不退出 Blender。使用 Blender 4.5 API（材质 use_nodes=True，Principled BSDF）。小场景，米为单位，Z 轴向上。保留已有对象 forma_id 自定义属性，局部修改必须按该 ID 查找，不能按名称猜测或清空场景。新建物体不赋旧 ID。使用 PBR 基础材质、点光源或太阳光，不使用约束/动画。对象可使用 EMPTY 父级做桌子/台灯等逻辑组，父级变换必须正确保留。不要用会清空已有场景的初始化代码，空白场景已由后台准备。可加入小倒角和平滑表面。脚本幂等不是要求，因为失败会重新从原版本运行。当前轮场景摘要是唯一事实，优先于旧对话；网页修改已保存到输入场景。不得回滚用户未要求改变的位置、颜色或缩放。summary 描述已生成的脚本意图，不能谎称已执行或验证。`;
export class CodexAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private bus = new EventEmitter();
  private starting?: Promise<void>;
  private loaded = new Set<string>();
  private disabledMcp: Record<string, boolean> = {};
  async start() {
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed) return;
    this.starting = this.boot().finally(() => (this.starting = undefined));
    return this.starting;
  }
  private async boot() {
    const args = ["app-server", "--listen", "stdio://"];
    for (const f of [
      "shell_tool",
      "unified_exec",
      "multi_agent",
      "multi_agent_v2",
      "apps",
      "plugins",
      "memories",
      "chronicle",
      "hooks",
      "browser_use",
      "computer_use",
      "image_generation",
      "skill_search",
      "code_mode",
      "code_mode_host",
      "view_image",
      "workspace_dependencies",
    ])
      args.push("-c", `features.${f}=false`);
    args.push("-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0");
    this.child = spawn(CODEX, args, {
      cwd: DATA,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", () => {}); // No authentication or inherited config is logged.
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && m.method) {
          if (m.method.includes("requestApproval"))
            this.send({ id: m.id, result: { decision: "decline" } });
          else
            this.send({
              id: m.id,
              error: { code: -32601, message: "工作台不允许工具或权限请求" },
            });
        } else if (m.id !== undefined) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error
              ? p.reject(new Error(m.error.message))
              : p.resolve(m.result);
          }
        } else if (m.method) this.bus.emit("event", m);
      } catch {
        /* Non-protocol output cannot become an application result. */
      }
    });
    const fail = () => {
      this.child = undefined;
      this.loaded.clear();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Codex App Server 连接中断"));
      }
      this.pending.clear();
      this.bus.emit("disconnect");
    };
    this.child.on("error", fail);
    this.child.on("exit", fail);
    await this.rpc("initialize", {
      clientInfo: {
        name: "ai_formadesk",
        title: "Ai-FormaDesk",
        version: "1.0.0",
      },
    });
    this.send({ method: "initialized" });
    // Read configuration only to turn off inherited MCP connections for this child's threads.
    const cfg = await this.rpc("config/read", { includeLayers: false });
    for (const key of Object.keys(cfg?.config?.mcp_servers || {}))
      this.disabledMcp[`mcp_servers.${key}.enabled`] = false;
  }
  private send(v: unknown) {
    this.child?.stdin.write(JSON.stringify(v) + "\n");
  }
  private rpc(method: string, params: unknown, ms = 60000): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 协议超时：${method}`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async health() {
    try {
      await this.start();
      const [a, m, v] = await Promise.all([
        this.rpc("account/read", {}),
        this.rpc("model/list", { includeHidden: true, limit: 100 }),
        runProcess(CODEX, ["--version"]),
      ]);
      const model = m.data?.find((x: any) => x.model === MODEL);
      if (v.stdout.trim() !== "codex-cli 0.153.4")
        throw new Error(
          "CLI 版本与已验证的 0.153.4 协议不一致；请重新生成协议类型并进行兼容验证，工作台不会自动升级。",
        );
      return {
        ok:
          !!a.account &&
          !!model?.supportedReasoningEfforts?.some(
            (x: any) => x.reasoningEffort === EFFORT,
          ),
        version: v.stdout.trim(),
        loggedIn: !!a.account,
        authType: a.account?.type || null,
        model: MODEL,
        effort: EFFORT,
        modelAvailable: !!model,
        error: !a.account
          ? "本机 Codex 尚未登录，请在终端完成原有登录后重新检查"
          : !model
            ? "本机模型列表中没有 gpt-6-astra"
            : null,
      };
    } catch (e) {
      return {
        ok: false,
        error: (e as Error).message,
        model: MODEL,
        effort: EFFORT,
      };
    }
  }
  async generate(
    projectId: string,
    threadId: string | null,
    prompt: string,
    signal: AbortSignal,
    onThread: (id: string) => void,
    onActivity: (text: string) => void,
  ) {
    await this.start();
    const cwd = path.join(DATA, "codex-workspaces", projectId);
    fs.mkdirSync(cwd, { recursive: true });
    const config = { ...this.disabledMcp, model_reasoning_effort: EFFORT };
    if (!threadId || !this.loaded.has(threadId)) {
      const params: ThreadStartParams = {
        model: MODEL,
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: instructions,
        config,
      };
      const r = await this.rpc(
        threadId ? "thread/resume" : "thread/start",
        threadId ? { ...params, threadId } : params,
      );
      threadId = r.thread.id;
      this.loaded.add(threadId!);
      onThread(threadId!);
    }
    if (signal.aborted) throw new Error("任务已取消");
    const tid = threadId!;
    let turnId: string | undefined;
    let final = "";
    return await new Promise<z.infer<typeof response>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.bus.off("event", event);
        this.bus.off("disconnect", disconnect);
      };
      const stop = () => {
        if (turnId)
          void this.rpc(
            "turn/interrupt",
            { threadId: tid, turnId },
            10000,
          ).catch(() => {});
      };
      const abort = () => {
        stop();
        cleanup();
        reject(new Error("任务已取消"));
      };
      const disconnect = () => {
        cleanup();
        reject(new Error("Codex App Server 连接中断"));
      };
      const timer = setTimeout(() => {
        stop();
        cleanup();
        reject(new Error("AI 生成超过 10 分钟，已停止"));
      }, 600000);
      const event = (m: any) => {
        const p = m.params;
        if (p?.threadId !== tid) return;
        if (m.method === "turn/started") {
          turnId = p.turn.id;
          if (signal.aborted) stop();
        }
        if (m.method === "item/agentMessage/delta")
          onActivity("Codex 正在生成建模脚本");
        if (m.method === "item/completed" && p.item?.type === "agentMessage")
          final = p.item.text;
        if (m.method === "turn/completed") {
          cleanup();
          if (p.turn.status !== "completed")
            return reject(new Error(p.turn.error?.message || "AI 生成被中断"));
          try {
            resolve(response.parse(JSON.parse(final)));
          } catch {
            reject(new Error("Codex 未返回有效建模脚本，未执行任何场景修改"));
          }
        }
      };
      this.bus.on("event", event);
      this.bus.on("disconnect", disconnect);
      signal.addEventListener("abort", abort, { once: true });
      const params: TurnStartParams = {
        threadId: tid,
        cwd,
        model: MODEL,
        effort: EFFORT,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [{ type: "text", text: prompt, text_elements: [] }],
        outputSchema: {
          type: "object",
          properties: {
            python: { type: "string" },
            summary: { type: "string" },
          },
          required: ["python", "summary"],
          additionalProperties: false,
        },
      };
      this.rpc("turn/start", params)
        .then((r) => {
          turnId = r.turn.id;
          if (signal.aborted) stop();
        })
        .catch((e) => {
          cleanup();
          reject(e);
        });
    });
  }
  close() {
    this.child?.kill("SIGTERM");
  }
}
export const codex = new CodexAdapter();
