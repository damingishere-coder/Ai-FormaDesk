import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  ChevronDown,
  Check,
  Undo2,
  Redo2,
  Download,
  Image,
  MousePointer2,
  Move,
  RotateCw,
  Scaling,
  Scan,
  Layers,
  History,
  MessageSquare,
  ArrowUp,
  Square,
  X,
  Plus,
  Loader2,
  AlertCircle,
  Settings2,
  EyeOff,
  Lightbulb,
  CheckCircle2,
  ExternalLink,
  Maximize,
  FolderOpen,
  Pencil,
} from "lucide-react";
import { api } from "./api";
import { Viewport, type ViewportHandle } from "./Viewport";
import { Inspector } from "./Inspector";
import type { Project, Snapshot, Job, SceneCommand, Revision } from "./types";
const terminal = (j: Job) =>
  ["succeeded", "failed", "cancelled"].includes(j.status);
const shortDate = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
export function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [pid, setPid] = useState(localStorage.getItem("forma-project") || ""),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [health, setHealth] = useState<any>(null),
    [selected, setSelected] = useState<string | null>(null),
    [mode, setMode] = useState<"select" | "translate" | "rotate" | "scale">(
      "select",
    ),
    [panel, setPanel] = useState(""),
    [prompt, setPrompt] = useState(""),
    [job, setJob] = useState<Job | null>(null),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [renderView, setRenderView] = useState(false),
    [newName, setNewName] = useState(""),
    [rename, setRename] = useState(false),
    [view, setView] = useState("perspective"),
    [reloadKey, setReloadKey] = useState(0);
  const viewport = useRef<ViewportHandle>(null),
    currentPid = useRef(pid),
    submitLock = useRef(false);
  currentPid.current = pid;
  const busy = submitting || (!!job && !terminal(job));
  const object = snapshot?.scene.objects.find((o) => o.id === selected);
  const base = snapshot?.project.currentRevisionId || null;
  const load = useCallback(async (id: string) => {
    const v = await api<Snapshot>(`/projects/${id}/scene`);
    if (currentPid.current !== id) return;
    setSnapshot(v);
    setSelected((s) => (v.scene.objects.some((o) => o.id === s) ? s : null));
    if (v.activeJob) setJob(v.activeJob);
    return v;
  }, []);
  const loadProjects = async () => {
    const p = await api<Project[]>("/projects");
    setProjects(p);
    return p;
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [p, h] = await Promise.all([loadProjects(), api("/health")]);
        if (!alive) return;
        setHealth(h);
        if (p.length && !p.some((x) => x.id === currentPid.current))
          setPid(p[0].id);
        else if (!p.length) {
          const n = await api<Project>("/projects", { name: "我的第一个作品" });
          setProjects([n]);
          setPid(n.id);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!pid) return;
    currentPid.current = pid;
    localStorage.setItem("forma-project", pid);
    setSnapshot(null);
    setJob(null);
    setSelected(null);
    setRenderView(false);
    setReloadKey(0);
    void load(pid).catch((e) => setError(e.message));
  }, [pid, load]);
  useEffect(() => {
    if (health?.checking) {
      const timer = setInterval(
        () => void api("/health").then(setHealth),
        1800,
      );
      return () => clearInterval(timer);
    }
  }, [health?.checking]);
  useEffect(() => {
    if (!job || terminal(job)) return;
    const jid = job.id,
      p = job.projectId;
    let disposed = false;
    let ending = false;
    const receive = async (j: Job) => {
      if (disposed || currentPid.current !== p) return;
      setJob(j);
      if (terminal(j) && !ending) {
        ending = true;
        setSubmitting(false);
        submitLock.current = false;
        setReloadKey((k) => k + 1);
        await load(p);
        if (j.status === "succeeded") {
          setNotice(j.message || "已保存");
          if (j.type === "render") setRenderView(true);
        } else setError(j.error || "任务已取消");
      }
    };
    const source = new EventSource(`/api/jobs/${jid}/events`);
    source.onmessage = (e) => void receive(JSON.parse(e.data));
    source.onerror = () => {
      void api<Job>(`/jobs/${jid}`)
        .then(receive)
        .catch((e) => setError(e.message));
    };
    const poll = setInterval(
      () =>
        void api<Job>(`/jobs/${jid}`)
          .then(receive)
          .catch((e) => setError(e.message)),
      4000,
    );
    return () => {
      disposed = true;
      source.close();
      clearInterval(poll);
    };
  }, [job?.id, job?.status, load]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest("input,textarea,select,[contenteditable=true]") ||
        busy
      )
        return;
      const map: Record<string, typeof mode> = {
        w: "translate",
        e: "rotate",
        r: "scale",
      };
      if (map[e.key.toLowerCase()]) {
        setMode(map[e.key.toLowerCase()]);
        e.preventDefault();
      }
      if (e.key === "Escape") {
        setSelected(null);
        setPanel("");
      }
      if (e.key.toLowerCase() === "f") viewport.current?.fit();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy]);
  async function startJob(endpoint: string, body: unknown) {
    if (submitLock.current || busy) return;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const j = await api<Job>(`/projects/${pid}/${endpoint}`, body);
      setJob(j);
    } catch (e) {
      setError((e as Error).message);
      await load(pid);
      setReloadKey((k) => k + 1);
    } finally {
      setSubmitting(false);
      submitLock.current = false;
    }
  }
  async function generate() {
    if (!prompt.trim()) return;
    const text = prompt;
    await startJob("generate", {
      baseRevisionId: base,
      prompt: text,
      objectId: selected,
    });
    setPrompt("");
  }
  async function command(c: Partial<SceneCommand>, id = selected) {
    if (!base || !id) return;
    await startJob("commands", { ...c, objectId: id, baseRevisionId: base });
  }
  async function history(
    action: "undo" | "redo" | "restore",
    revisionId?: string,
  ) {
    if (busy) return;
    setSubmitting(true);
    setError("");
    try {
      await api(`/projects/${pid}/restore`, {
        baseRevisionId: base,
        revisionId,
        action,
      });
      await load(pid);
      setReloadKey((k) => k + 1);
      setNotice("已切换到保存版本");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function openPanel(name: string) {
    setPanel(panel === name ? "" : name);
    if (name === "history")
      setRevisions(await api(`/projects/${pid}/revisions`));
    if (name === "projects") await loadProjects();
  }
  async function saveProject() {
    if (!newName.trim()) return;
    try {
      if (rename) {
        await api(`/projects/${pid}`, { name: newName }, "PATCH");
        await load(pid);
      } else {
        const p = await api<Project>("/projects", { name: newName });
        setPid(p.id);
      }
      await loadProjects();
      setNewName("");
      setRename(false);
      setPanel("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function render() {
    if (!base || !viewport.current) return;
    await startJob("render", {
      baseRevisionId: base,
      camera: viewport.current.camera(),
    });
  }
  const saved = !!snapshot && !busy;
  const renderStale = !!snapshot?.render && snapshot.render.revisionId !== base;
  return (
    <div className="workbench">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ai-FormaDesk 首页">
          <span className="brand-mark">
            <Box size={26} strokeWidth={1.45} />
          </span>
          <span>Ai-FormaDesk</span>
        </a>
        <span className="divider" />
        <button
          className="project-trigger"
          onClick={() => void openPanel("projects")}
        >
          <span>{snapshot?.project.name || "载入项目…"}</span>
          <ChevronDown size={15} />
        </button>
        <span
          className={"save-indicator " + (saved ? "saved" : "")}
          title={saved ? "当前版本已保存到 Blender" : "等待任务确认"}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <CheckCircle2 size={15} />
          )}
          <span>{busy ? "处理中" : base ? "已保存" : "空白项目"}</span>
        </span>
        <div className="top-actions">
          <button
            className="icon"
            aria-label="撤销"
            disabled={busy || !base}
            onClick={() => void history("undo")}
          >
            <Undo2 size={20} />
          </button>
          <button
            className="icon"
            aria-label="重做"
            disabled={busy || !snapshot?.project.redo.length}
            onClick={() => void history("redo")}
          >
            <Redo2 size={20} />
          </button>
          <span className="action-separator" />
          <button
            className="button"
            disabled={!base || busy}
            onClick={() => void render()}
          >
            <Image size={16} />
            渲染
          </button>
          <button
            className="button dark"
            disabled={!base}
            onClick={() => void openPanel("export")}
          >
            <Download size={16} />
            导出
          </button>
        </div>
      </header>
      <main className="canvas-stage" aria-label="三维工作画布">
        {snapshot && (
          <Viewport
            key={pid}
            ref={viewport}
            url={
              snapshot.previewUrl
                ? snapshot.previewUrl + "?reload=" + reloadKey
                : null
            }
            scene={snapshot.scene}
            selected={selected}
            onSelect={setSelected}
            mode={mode}
            busy={busy}
            onTransform={(id, t) =>
              void command({ operation: "transform", transform: t }, id)
            }
            onError={setError}
          />
        )}
      </main>
      {renderView && snapshot?.render && (
        <div className="render-stage">
          <img
            src={`/api/artifacts/${snapshot.render.artifactId}`}
            alt="当前保存版本的真实 Blender 渲染"
          />
          <div className={"render-caption " + (renderStale ? "stale" : "")}>
            {renderStale ? "需要重新渲染 · 场景已有修改" : "EEVEE · 1280 × 720"}
            <span>
              版本 {snapshot.render.revisionId.slice(0, 8)} ·{" "}
              {shortDate(snapshot.render.createdAt)}
            </span>
          </div>
        </div>
      )}
      <div className="mode-switch glass">
        <button
          className={!renderView ? "active" : ""}
          onClick={() => setRenderView(false)}
        >
          编辑
        </button>
        <button
          className={renderView ? "active" : ""}
          disabled={!snapshot?.render}
          onClick={() => setRenderView(true)}
        >
          渲染预览{renderStale && <i />}
        </button>
      </div>
      {!base && !busy && (
        <div className="empty-state">
          <div className="empty-cube">
            <Box strokeWidth={0.8} size={66} />
          </div>
          <span className="eyebrow">想法，从这里成形</span>
          <h1>
            把脑海里的物件
            <br />
            放进眼前的空间。
          </h1>
          <p>描述你想创造的东西，剩下的交给造物。</p>
          <button
            className="example"
            onClick={() => setPrompt("做一张木桌，桌上放一盏绿色台灯。")}
          >
            试试「木桌和绿色台灯」
            <ArrowUp size={14} />
          </button>
        </div>
      )}
      {!renderView && (
        <nav className="tool-rail glass" aria-label="建模工具">
          {[
            { mode: "select", label: "选择", key: "", icon: MousePointer2 },
            { mode: "translate", label: "移动", key: "W", icon: Move },
            { mode: "rotate", label: "旋转", key: "E", icon: RotateCw },
            { mode: "scale", label: "缩放", key: "R", icon: Scaling },
          ].map((t) => (
            <button
              key={t.mode}
              className={"tool " + (mode === t.mode ? "active" : "")}
              aria-label={t.label}
              title={`${t.label} ${t.key}`}
              disabled={busy}
              onClick={() => setMode(t.mode as typeof mode)}
            >
              <t.icon size={22} strokeWidth={1.6} />
            </button>
          ))}
          <span />
          <button
            className="tool"
            aria-label="适应模型"
            title="适应模型 F"
            onClick={() => viewport.current?.fit()}
          >
            <Scan size={22} strokeWidth={1.6} />
          </button>
        </nav>
      )}
      {object && !renderView && (
        <Inspector
          key={object.id}
          object={object}
          busy={busy}
          onClose={() => setSelected(null)}
          onCommand={(c) => void command(c)}
        />
      )}
      {(error || notice) && (
        <div
          className={"toast glass " + (error ? "error" : "")}
          role={error ? "alert" : "status"}
        >
          {error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{error || notice}</span>
          <button
            className="icon"
            aria-label="关闭提示"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <section
        className={
          "composer-wrap " + (object && !renderView ? "has-selection" : "")
        }
        aria-label="AI 建模对话"
      >
        <button className="history-link" onClick={() => void openPanel("chat")}>
          <MessageSquare size={14} />
          对话记录
          {snapshot?.messages.length ? ` · ${snapshot.messages.length}` : ""}
        </button>
        <div className="composer glass">
          <div className="context-line">
            {object ? (
              <button
                className="selection-chip"
                onClick={() => setSelected(null)}
              >
                <Box size={14} />
                <span>{object.name}</span>
                <X size={12} />
              </button>
            ) : (
              <span className="context-dot" />
            )}
            <span className="context-text">
              {busy
                ? job?.stage || "正在提交任务…"
                : job?.status === "succeeded" && job.message
                  ? job.message
                  : base
                    ? "继续雕琢你的想法，或选中模型直接调整。"
                    : "每一个好作品，都从一个想法开始。"}
            </span>
            {busy && <Loader2 size={14} className="spin" />}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <textarea
              aria-label="建模需求"
              value={prompt}
              placeholder={
                base
                  ? "继续描述，或选中模型直接调整…"
                  : "想创造什么？例如，一张木桌和绿色台灯…"
              }
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (!busy && health?.ok) void generate();
                }
              }}
              disabled={busy}
              rows={2}
            />
            <div className="composer-bottom">
              <button
                type="button"
                className="model-badge"
                onClick={() => void openPanel("health")}
              >
                <span className={"status-dot " + (health?.ok ? "ok" : "")} />
                Codex<span className="model-detail">Astra · 高</span>
              </button>
              <span className="input-hint">
                Enter 发送 · Shift + Enter 换行
              </span>
              {busy ? (
                <button
                  type="button"
                  className="send stop"
                  aria-label="停止任务"
                  onClick={() =>
                    job &&
                    void api(`/jobs/${job.id}/cancel`, {}).catch((e) =>
                      setError(e.message),
                    )
                  }
                >
                  <Square size={17} />
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="发送建模需求"
                  disabled={!prompt.trim() || !health?.ok || !snapshot}
                >
                  <ArrowUp size={23} />
                </button>
              )}
            </div>
          </form>
        </div>
      </section>
      <div className="bottom-left">
        <button
          className={"button glass " + (panel === "scene" ? "pressed" : "")}
          onClick={() => void openPanel("scene")}
        >
          <Layers size={17} />
          场景 · {snapshot?.scene.objects.length || 0}
          <ChevronDown size={13} />
        </button>
        <button
          className="round glass"
          aria-label="版本历史"
          onClick={() => void openPanel("history")}
        >
          <History size={20} />
        </button>
      </div>
      <div className="bottom-right">
        <button
          className="round glass"
          aria-label="环境检查"
          onClick={() => void openPanel("health")}
        >
          <Settings2 size={18} />
          {health && !health.ok && <i className="warning-dot" />}
        </button>
        <div className="view-picker glass">
          <select
            aria-label="观察视角"
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              viewport.current?.view(e.target.value);
              setRenderView(false);
            }}
          >
            <option value="perspective">透视视角</option>
            <option value="front">正面</option>
            <option value="side">侧面</option>
            <option value="top">顶部</option>
          </select>
          <button
            className="icon"
            aria-label="适应画布"
            onClick={() => viewport.current?.fit()}
          >
            <Maximize size={18} />
          </button>
        </div>
      </div>
      {panel === "scene" && (
        <aside className="scene-popover glass">
          <header>
            <strong>场景对象</strong>
            <button
              className="icon"
              onClick={() => setPanel("")}
              aria-label="关闭场景列表"
            >
              <X size={16} />
            </button>
          </header>
          {!snapshot?.scene.objects.length ? (
            <p className="muted">还没有物件，先描述一个想法。</p>
          ) : (
            <div className="object-list">
              {snapshot.scene.objects.map((o) => (
                <button
                  key={o.id}
                  className={o.id === selected ? "active" : ""}
                  data-object-id={o.id}
                  onClick={() => {
                    setSelected(o.id);
                    setRenderView(false);
                  }}
                  style={{ paddingLeft: o.parentId ? 26 : 12 }}
                >
                  {o.type === "LIGHT" ? (
                    <Lightbulb size={15} />
                  ) : (
                    <Box size={15} />
                  )}
                  <span>{o.name}</span>
                  {!o.visible && <EyeOff size={13} />}
                  <small>{o.id.slice(0, 4)}</small>
                </button>
              ))}
            </div>
          )}
          <footer>
            {snapshot?.scene.stats.vertices.toLocaleString() || 0} 顶点 ·{" "}
            {snapshot?.scene.stats.triangles.toLocaleString() || 0} 三角面
          </footer>
        </aside>
      )}
      {["projects", "history", "chat", "export", "health"].includes(panel) && (
        <div className="modal-backdrop" onClick={() => setPanel("")}>
          <section
            className={"modal glass " + (panel === "chat" ? "chat-modal" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={
              {
                projects: "项目",
                history: "版本历史",
                chat: "对话记录",
                export: "导出作品",
                health: "环境检查",
              }[panel]
            }
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>
                {
                  {
                    projects: "你的作品",
                    history: "每一步，都可以回去",
                    chat: "创作对话",
                    export: "带走你的作品",
                    health: "本地工作台检查",
                  }[panel]
                }
              </h2>
              <button
                className="icon"
                aria-label="关闭窗口"
                onClick={() => setPanel("")}
              >
                <X size={20} />
              </button>
            </header>
            {panel === "projects" && (
              <>
                <p className="muted">作品保存在这台 Mac 上。</p>
                <div className="project-list">
                  {projects.map((p) => (
                    <button
                      className={p.id === pid ? "current" : ""}
                      key={p.id}
                      onClick={() => {
                        setPid(p.id);
                        setPanel("");
                      }}
                    >
                      <FolderOpen size={21} />
                      <span>
                        {p.name}
                        <small>{shortDate(p.createdAt)}</small>
                      </span>
                      {p.id === pid && <Check size={16} />}
                    </button>
                  ))}
                </div>
                <form
                  className="new-project"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveProject();
                  }}
                >
                  <input
                    aria-label={rename ? "项目新名称" : "新项目名称"}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={rename ? "输入当前项目的新名称" : "新作品名称"}
                  />
                  <button className="button dark" disabled={!newName.trim()}>
                    {rename ? <Pencil size={15} /> : <Plus size={16} />}{" "}
                    {rename ? "重命名" : "新建"}
                  </button>
                </form>
                <button
                  className="text-button"
                  onClick={() => {
                    setRename(!rename);
                    setNewName(rename ? "" : snapshot?.project.name || "");
                  }}
                >
                  {rename ? "取消重命名" : "重命名当前项目"}
                </button>
              </>
            )}
            {panel === "history" && (
              <>
                <p className="muted">
                  每次成功修改保存一个独立版本。恢复后继续创作，原历史依然保留。
                </p>
                <div className="revision-list">
                  {[...revisions].reverse().map((r, i) => (
                    <div key={r.id} className={r.id === base ? "current" : ""}>
                      <span className="revision-dot" />
                      <div>
                        <strong>{r.label}</strong>
                        <small>
                          {shortDate(r.createdAt)} · {r.id.slice(0, 8)} ·{" "}
                          {r.source === "generate" ? "AI 建模" : "网页编辑"}
                        </small>
                      </div>
                      <button
                        className="button"
                        disabled={busy || r.id === base}
                        onClick={() => void history("restore", r.id)}
                      >
                        {r.id === base ? "当前" : "恢复"}
                      </button>
                    </div>
                  ))}
                  {!revisions.length && (
                    <p className="muted">第一个作品生成后，这里会留下记录。</p>
                  )}
                </div>
              </>
            )}
            {panel === "chat" && (
              <div className="chat-log">
                {snapshot?.messages.map((m, i) => (
                  <article key={i} className={m.role}>
                    <small>
                      {m.role === "user"
                        ? "你"
                        : m.role === "error"
                          ? "执行反馈"
                          : "Codex"}{" "}
                      · {shortDate(m.createdAt)}
                    </small>
                    <p>{m.text}</p>
                  </article>
                ))}
                {!snapshot?.messages.length && (
                  <p className="muted">还没有对话。用一句话，开始你的创作。</p>
                )}
              </div>
            )}
            {panel === "export" && snapshot?.revision && (
              <>
                <p className="muted">
                  导出已保存版本 <b>{base?.slice(0, 8)}</b>
                  。模型包含所有已确认的网页修改。
                </p>
                <div className="export-options">
                  {[
                    [
                      "blend",
                      "Blender 源文件",
                      ".blend · 完整场景，可继续编辑",
                    ],
                    ["glb", "通用三维模型", ".glb · 适用于网页和其他 3D 工具"],
                  ].map(([k, title, desc]) => (
                    <a
                      key={k}
                      href={`/api/artifacts/${snapshot.revision!.artifacts[k as "blend"]}?download=1`}
                    >
                      <Box size={24} />
                      <span>
                        <strong>{title}</strong>
                        <small>{desc}</small>
                      </span>
                      <Download size={17} />
                    </a>
                  ))}
                  {snapshot.render && !renderStale ? (
                    <a
                      href={`/api/artifacts/${snapshot.render.artifactId}?download=1`}
                    >
                      <Image size={24} />
                      <span>
                        <strong>渲染图像</strong>
                        <small>.png · 1280 × 720 · 当前版本</small>
                      </span>
                      <Download size={17} />
                    </a>
                  ) : (
                    <div className="export-unavailable">
                      <Image size={24} />
                      <span>
                        PNG {renderStale ? "需要重新渲染" : "尚未渲染"}
                        <small>关闭窗口后，点击顶部「渲染」。</small>
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
            {panel === "health" && (
              <>
                <p className="muted">
                  AI 复用本机 Codex 登录；建模和文件保存在本机。
                </p>
                {health ? (
                  <div className="health-list">
                    {[
                      [
                        "Codex CLI",
                        health.codex?.ok,
                        health.codex?.version || health.codex?.error,
                      ],
                      [
                        "模型与登录",
                        health.codex?.ok,
                        `${health.codex?.model || "gpt-6-astra"} · high${health.codex?.loggedIn ? " · 已登录" : ""}`,
                      ],
                      [
                        "Blender 4.5 LTS",
                        health.blender?.ok,
                        health.blender?.version || health.blender?.error,
                      ],
                      [
                        "执行沙箱",
                        health.sandbox?.ok,
                        health.sandbox?.ok
                          ? "越界读取、写入和网络均已实测阻止"
                          : health.sandbox?.error || "检查中",
                      ],
                    ].map(([name, ok, detail]) => (
                      <div key={String(name)}>
                        {ok ? (
                          <CheckCircle2 className="green" size={19} />
                        ) : (
                          <AlertCircle className="amber" size={19} />
                        )}
                        <span>
                          <strong>{name}</strong>
                          <small>{detail}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>正在检查…</p>
                )}
                <p className="field-note">
                  配置入口：项目 data/settings.json 可调整执行超时；Blender
                  路径使用 ZAOWU_BLENDER，Codex 路径使用
                  ZAOWU_CODEX。修改后重启工作台。登录问题请在终端运行 codex
                  login status 检查。
                </p>
                <button
                  className="button dark"
                  disabled={health?.checking}
                  onClick={() => {
                    setHealth({ ...health, checking: true });
                    void api("/health/recheck", {})
                      .then(setHealth)
                      .catch((e) => setError(e.message));
                  }}
                >
                  {health?.checking ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <RotateCw size={16} />
                  )}
                  重新检查
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
