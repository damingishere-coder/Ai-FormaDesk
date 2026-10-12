import { BlenderLink } from "./BlenderLink";
import {VideoRecorder} from "./VideoRecorder";
import type {VideoSettings} from "./types";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Box,
  ChevronDown,
  Check,
  Undo2,
  Redo2,
  Download,
  MousePointer2,
  Move,
  RotateCw,
  Scaling,
  Scan,
  Layers,
  History,
  ArrowUp,
  X,
  Loader2,
  AlertCircle,
  Settings2,
  EyeOff,
  Lightbulb,
  CheckCircle2,
  Maximize,
  MessageSquare,
} from "lucide-react";
import { api, ApiRequestError } from "./api";
import { useModalFocus } from "./modalFocus";
import { Viewport, type ViewportHandle } from "./Viewport";
import { Inspector } from "./Inspector";
import { Composer } from "./Composer";
import { ProjectLibrary } from "./ProjectLibrary";
import { ExportPanel, type ExportTab } from "./ExportPanel";
import { VideoExport, defaultVideoSettings, validVideoSettings } from "./VideoExport";
import { RenderPreview } from "./RenderPreview";
import { CompositionToolbar, ImageExport } from "./ImageExport";
import { validImageSettings } from "./imageComposition";
import {
  defaultRenderSettings,
  type RenderSettings,
  type CameraSpec,
  type Proposal,
} from "./types";
import type { Project, Snapshot, Job, SceneCommand, Revision } from "./types";
import { VisualReferences } from "./VisualReferences";
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
  const [resumeId, setResumeId] = useState(localStorage.getItem("forma-project") || "");
  const [pid, setPid] = useState(""),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [health, setHealth] = useState<any>(null),
    [selected, setSelected] = useState<string | null>(null),
    [mode, setMode] = useState<"select" | "translate" | "rotate" | "scale">(
      "select",
    ),
    [panel, setPanel] = useState("projects"),
    [prompt, setPrompt] = useState(""),
    [job, setJobState] = useState<Job | null>(null),
    [submitting, setSubmitting] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [renderView, setRenderView] = useState(false),
    [view, setView] = useState("perspective"),
    [reloadKey, setReloadKey] = useState(0);
  const [recording,setRecording]=useState<VideoSettings|null>(null);
  const [previewStatus,setPreviewStatus]=useState<'loading'|'ready'|'failed'>('loading');
  const jobRef = useRef<Job | null>(null);
  const loadSequence = useRef(0);
  const submissionSequence = useRef(0);
  const healthSequence = useRef(0);
  const healthPolling = useRef(false);
  const [healthError, setHealthError] = useState("");
  const [healthStale, setHealthStale] = useState(false);
  const appModal = useRef<HTMLElement>(null);
  useModalFocus(["history", "health"].includes(panel) ? panel : false, appModal, () => setPanel(""));
  const setJob = useCallback((value: Job | null) => {
    jobRef.current = value;
    setJobState(value);
  }, []);
  const [previewRevision,setPreviewRevision]=useState<string|null>(null);
  const [disconnected,setDisconnected]=useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [chatHidden, setChatHidden] = useState(() => localStorage.getItem("forma-chat-hidden") === "true");
  const [chatUnread, setChatUnread] = useState(false);
  const lastReply = snapshot?.messages.filter(m => m.role === "assistant").at(-1);
  const seenReply = useRef<{ pid: string; key: string } | null>(null);
  useEffect(() => {
    localStorage.setItem("forma-chat-hidden", String(chatHidden));
  }, [chatHidden]);
  useEffect(() => {
    if (!snapshot) return;
    const key = lastReply ? `${pid}:${lastReply.id}:${lastReply.status}:${lastReply.text}` : "";
    if (chatHidden && seenReply.current?.pid === pid && key && key !== seenReply.current.key && lastReply?.status !== "pending") setChatUnread(true);
    seenReply.current = { pid, key };
  }, [pid, snapshot, lastReply?.id, lastReply?.status, lastReply?.text, chatHidden]);
  function changeChatExpanded(expanded: boolean) {
    setChatExpanded(expanded);
    if (expanded && !chatHidden) {
      setPanel("");
      setInspectorOpen(false);
    }
  }
  function showChat() {
    setChatHidden(false);
    setChatUnread(false);
    setChatExpanded(true);
    setPanel("");
    setInspectorOpen(false);
  }
  function selectObject(id: string | null) {
    setSelected(id);
    setInspectorOpen(!!id);
    setPanel(current => current === "scene" ? current : "");
    setRenderView(false);
    setChatExpanded(false);
  }
  const [showRender, setShowRender] = useState(false);
  const [imageExport, setImageExport] = useState(false);
  const [exportTab, setExportTab] = useState<ExportTab>("image");
  const [videoSettings, setVideoSettings] = useState<VideoSettings>(defaultVideoSettings);
  const entryCamera = useRef<CameraSpec | null>(null);
  const [settings, setSettings] = useState<RenderSettings>(
    defaultRenderSettings,
  );
  const [cameraState, setCameraState] = useState<CameraSpec | null>(null);
  const onCameraChange = useCallback((v: CameraSpec) => {
    setCameraState((old) =>
      JSON.stringify(old) === JSON.stringify(v) ? old : v,
    );
  }, []);
  const viewport = useRef<ViewportHandle>(null),
    currentPid = useRef(pid),
    submitLock = useRef(false);
  currentPid.current = pid;
  const busy = submitting || (!!job && job.projectId === pid && job.type !== "preview" && !terminal(job));
  function isContext(expectedPid: string, expectedJobId?: string) {
    return currentPid.current === expectedPid && jobRef.current?.id === expectedJobId;
  }
  function acceptJob(expectedPid: string, expectedJobId: string | undefined, value: Job) {
    if (!isContext(expectedPid, expectedJobId) || value.projectId !== expectedPid) return false;
    setJob(value);
    return true;
  }
  async function refreshHealth(recheck = false) {
    const sequence = ++healthSequence.current;
    if (recheck) setHealth((value: any) => ({ ...value, checking: true }));
    try {
      const value = await api(recheck ? "/health/recheck" : "/health", recheck ? {} : undefined);
      if (sequence !== healthSequence.current) return;
      setHealth(value);
      setHealthStale(false);
      setHealthError("");
    } catch (error) {
      if (sequence !== healthSequence.current) return;
      setHealth((value: any) => ({ ...value, checking: false }));
      setHealthStale(true);
      setHealthError("环境状态无法确认：" + (error as Error).message);
    }
  }
  const object = snapshot?.scene.objects.find((o) => o.id === selected);
  const base = snapshot?.project.currentRevisionId || null;
  useEffect(() => {
    if (imageExport && previewStatus === "ready" && previewRevision === base && !entryCamera.current) {
      entryCamera.current = viewport.current?.camera() || null;
    }
  }, [imageExport, previewStatus, previewRevision, base]);
  const load = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current;
    const observedJob = jobRef.current?.id;
    const v = await api<Snapshot>(`/projects/${id}/scene`);
    if (currentPid.current !== id || sequence !== loadSequence.current || jobRef.current?.id !== observedJob) return;
    if (v?.project?.id !== id) throw new ApiRequestError("后台返回的项目归属无法确认，请重新加载后再操作。");
    setSnapshot(v);
    setSelected((s) => (v.scene.objects.some((o) => o.id === s) ? s : null));
    if (v.activeJob) setJob(v.activeJob);
    else setJob(v.jobs?.at(-1) || null);
    return v;
  }, []);
  const loadProjects = async () => {
    const p = await api<Project[]>("/projects");
    return p;
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [p] = await Promise.all([loadProjects(), refreshHealth()]);
        if (!alive) return;
        if (
          !currentPid.current ||
          !p.some((x) => x.id === currentPid.current)
        ) {
          setPid("");
          setPanel("projects");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      healthSequence.current++;
    };
  }, []);
  useEffect(() => {
    submissionSequence.current++;
    submitLock.current = false;
    setSubmitting(false);
    setError("");
    setNotice("");
    setDisconnected(false);
    if (!pid) {
      setSnapshot(null);
      setJob(null);
      return;
    }
    currentPid.current = pid;
    localStorage.setItem("forma-project", pid);
    setSnapshot(null);
    setJob(null);
    setSelected(null);
    setInspectorOpen(false);
    setRenderView(false);
    setShowRender(false);
    setImageExport(false);
    setExportTab("image");
    setVideoSettings(defaultVideoSettings);
    entryCamera.current = null;
    setChatExpanded(false);
    setChatUnread(false);
    setSettings(defaultRenderSettings);
    setReloadKey(0);
    const expectedPid = pid;
    void load(expectedPid).catch((e) => {
      if (currentPid.current === expectedPid) setError(e.message);
    });
  }, [pid, load]);
  useEffect(() => {
    if (health?.checking) {
      const timer = setInterval(() => {
        if (healthPolling.current) return;
        healthPolling.current = true;
        void refreshHealth().finally(() => { healthPolling.current = false; });
      }, 1800);
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
      if (disposed || j.id !== jid || j.projectId !== p || currentPid.current !== p || jobRef.current?.id !== jid || (j.type === "preview" && submitLock.current)) return;
      setDisconnected(false);
      setJob(j);
      if (terminal(j) && !ending) {
        ending = true;
        setSubmitting(false);
        submitLock.current = false;
        if (j.type !== "discuss" && j.type !== "render" && j.type !== "video")
          setReloadKey((k) => k + 1);
        await load(p).catch(e => {
          if (isContext(p, jid)) setError("刷新任务状态失败：" + e.message);
        });
        if (!isContext(p, jid)) return;
        if (j.status === "succeeded") {
          if (j.type !== "discuss")
            setNotice(
              j.type === "generate"
                ? "建模已完成，详细结果保存在对话中。"
                : j.message || "已保存",
            );
          if (j.type === "render") {
            setRenderView(true);
            setShowRender(true);
            setPanel("");
          }
        } else setError(j.error || "任务已取消");
      }
    };
    const fail = (error: Error) => {
      if (disposed || ending || !isContext(p, jid)) return;
      setDisconnected(true);
      setError("任务状态无法确认：" + error.message);
    };
    const source = new EventSource(`/api/jobs/${jid}/events`);
    source.onmessage = (event) => {
      try { void receive(JSON.parse(event.data)).catch(fail); }
      catch (error) { fail(error as Error); }
    };
    let polling = false;
    const pollJob = async () => {
      if (disposed || ending || polling || !isContext(p, jid)) return;
      polling = true;
      try { await receive(await api<Job>(`/jobs/${jid}`)); }
      catch (error) { fail(error as Error); }
      finally { polling = false; }
    };
    source.onerror = () => {
      if (!disposed && !ending && isContext(p, jid)) setDisconnected(true);
      void pollJob();
    };
    const poll = setInterval(() => void pollJob(), 4000);
    return () => {
      disposed = true;
      source.close();
      clearInterval(poll);
    };
  }, [job?.id, job?.status, load]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (recording||document.querySelector(".project-home")||document.querySelector('[aria-modal="true"]')) return;
      if (imageExport) {
        if (e.key === "Escape") setImageExport(false);
        return;
      }
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
        setChatExpanded(false);
        setShowRender(false);
        setSelected(null);
        setPanel("");
      }
      if (e.key.toLowerCase() === "f") viewport.current?.fit();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy,recording,imageExport]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function startJob(endpoint: string, body: unknown, retryId?: string) {
    if (submitLock.current || busy) return false;
    submitLock.current = true;
    const sequence = ++submissionSequence.current;
    const taskPid = pid;
    const expectedJobId = jobRef.current?.id;
    const knownJobs = new Set([...(snapshot?.jobs || []).map(value => value.id), ...(expectedJobId ? [expectedJobId] : [])]);
    const expectedType = retryId ? snapshot?.jobs?.find(value => value.id === retryId)?.type || (jobRef.current?.id === retryId ? jobRef.current.type : undefined) : endpoint.startsWith("videos/") ? "video" : (({ commands: "command", "blender/sync": "blender-sync", "blender/edit": "blender-edit" } as Record<string, string>)[endpoint] || endpoint);
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const value = await api<Job>(retryId ? `/jobs/${retryId}/retry` : `/projects/${taskPid}/${endpoint}`, body);
      if (!value || typeof value.id !== "string" || value.projectId !== taskPid)
        throw new ApiRequestError("后台返回的任务归属无法确认，请核对最新项目状态后再操作。", true);
      if (sequence !== submissionSequence.current || !isContext(taskPid, expectedJobId)) return true;
      if (sequence !== submissionSequence.current || !acceptJob(taskPid, expectedJobId, value)) return true;
      // Accepted messages must not be resent just because refreshing the view failed.
      await load(taskPid).catch((error) => {
        if (isContext(taskPid, value.id)) setError("任务已提交，刷新状态失败：" + error.message);
      });
      return true;
    } catch (error) {
      const uncertain = error instanceof ApiRequestError && error.outcomeUnknown;
      const acceptedJobIn = (value?: Snapshot) => value?.project?.id === taskPid
        ? [value.activeJob, ...(Array.isArray(value.jobs) ? value.jobs : []).slice().reverse()].find(candidate => candidate && typeof candidate.id === "string" && candidate.projectId === taskPid && !knownJobs.has(candidate.id) && candidate.type === expectedType)
        : undefined;
      const acceptedIn = (value?: Snapshot) => !!acceptedJobIn(value);
      const candidate = error instanceof ApiRequestError && error.reconciled ? error.reconciliation as Snapshot | undefined : undefined;
      const reconciliation = candidate?.project?.id === taskPid && Array.isArray(candidate.scene?.objects)
        && Array.isArray(candidate.project.redo) && Array.isArray(candidate.messages) && Array.isArray(candidate.proposals)
        && (!candidate.activeJob || candidate.activeJob.projectId === taskPid)
        && (!candidate.revision || candidate.revision.projectId === taskPid)
        ? candidate : undefined;
      if (sequence !== submissionSequence.current || !isContext(taskPid, expectedJobId)) {
        // A rejected old write keeps that project's draft; only verified acceptance consumes it.
        return uncertain && acceptedIn(reconciliation);
      }
      let refreshed: Snapshot | undefined;
      try { refreshed = await load(taskPid); } catch { /* The original error remains actionable. */ }
      if (sequence !== submissionSequence.current || currentPid.current !== taskPid)
        return uncertain && acceptedIn(refreshed || reconciliation);
      const recovered = refreshed || reconciliation;
      const accepted = acceptedJobIn(recovered);
      if (uncertain && recovered && accepted) {
          if (!refreshed) {
            // The first read already proved acceptance; a later failed refresh cannot erase it.
            if (!isContext(taskPid, expectedJobId)) return true;
            if (!acceptJob(taskPid, expectedJobId, recovered.activeJob || accepted)) return false;
            setSnapshot(recovered);
            setSelected(value => recovered.scene.objects.some(object => object.id === value) ? value : null);
          }
          // Snapshot is authoritative, including a follow-up preview after a completed write.
          setNotice("后台已接受任务，已恢复最新状态。请等待结果，无需重复提交。");
          return true;
      }
      if (jobRef.current?.id !== expectedJobId) return false;
      setError((error as Error).message);
      if (endpoint !== "render") setReloadKey((key) => key + 1);
      return false;
    } finally {
      if (sequence === submissionSequence.current && currentPid.current === taskPid) {
        setSubmitting(false);
        submitLock.current = false;
      }
    }
  }
  async function discuss(text: string, attachmentIds: string[]) {
    return (
      (await startJob("discuss", {
        baseRevisionId: base,
        prompt: text,
        objectId: selected,
        attachmentIds,
      })) || false
    );
  }
  async function buildProposal(proposal: Proposal) {
    setChatExpanded(true);
    setPreviewStatus("loading");
    await startJob("generate", { proposalId: proposal.id });
  }
  async function command(c: Partial<SceneCommand>, id = selected) {
    if (!base || !id) return;
    await startJob("commands", { ...c, objectId: id, baseRevisionId: base });
  }
  async function history(action: "undo" | "redo" | "restore", revisionId?: string) {
    if (busy || submitLock.current || !snapshot) return;
    if (action === "undo" && !base) return;
    if (action === "redo" && !snapshot.project.redo.length) return;
    const taskPid = pid, expectedJobId = jobRef.current?.id;
    const sequence = ++submissionSequence.current;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      await api(`/projects/${taskPid}/restore`, { baseRevisionId: base, revisionId, action });
      if (sequence !== submissionSequence.current || !isContext(taskPid, expectedJobId)) return;
      await load(taskPid);
      if (sequence !== submissionSequence.current || currentPid.current !== taskPid) return;
      setReloadKey((key) => key + 1);
      setPanel("");
      setNotice(action === "undo" ? "已撤销上一步" : action === "redo" ? "已重做一步" : "已恢复所选版本");
    } catch (error) {
      if (sequence !== submissionSequence.current || !isContext(taskPid, expectedJobId)) return;
      if (error instanceof ApiRequestError && error.outcomeUnknown) {
        await load(taskPid).catch(() => {});
        if (sequence !== submissionSequence.current || currentPid.current !== taskPid) return;
        setReloadKey((key) => key + 1);
      }
      setError((error as Error).message);
    } finally {
      if (sequence === submissionSequence.current && currentPid.current === taskPid) {
        setSubmitting(false);
        submitLock.current = false;
      }
    }
  }
  async function openPanel(name: string) {
    if (name === "projects" && recording) { setError("正在录制，请先保存或结束录制后再切换作品。"); return; }
    if (name === "inspector") {
      setInspectorOpen(open => !open);
      setChatExpanded(false);
      setRenderView(false);
      return;
    }
    if (panel !== name && name !== "projects") setChatExpanded(false);
    if (name === "scene" || name === "inspector") setRenderView(false);
    setPanel(panel === name ? "" : name);
    if (name === "history") {
      const taskPid = pid, expectedJobId = jobRef.current?.id;
      try {
        const values = await api<Revision[]>(`/projects/${taskPid}/revisions`);
        if (isContext(taskPid, expectedJobId)) setRevisions(values);
      } catch (error) {
        if (isContext(taskPid, expectedJobId)) setError("读取版本历史失败：" + (error as Error).message);
      }
    }
  }
  async function render() {
    if (!base || !viewport.current || !imageExport || exportTab !== "image" || recording || !validImageSettings(settings)) return;
    const camera = viewport.current.camera();
    if (Math.abs(camera.aspect - settings.width / settings.height) > 0.001) {
      setError("取景画面正在更新，请稍后再生成图片。");
      return;
    }
    await startJob("render", {
      baseRevisionId: base,
      camera,
      settings: { ...settings },
    });
  }
  function openImageExport() {
    if (!imageExport) entryCamera.current = previewStatus === "ready" && previewRevision === base ? viewport.current?.camera() || null : null;
    setPanel("");
    setShowRender(false);
    setChatExpanded(false);
    setImageExport(true);
    setExportTab("image");
    setError("");
  }
  const saved = !!snapshot && !busy;
  const frameAspect =
    settings.width > 0 && settings.height > 0
      ? settings.width / settings.height
      : 16 / 9;
  const compositionAspect = exportTab === "video"
    ? validVideoSettings(videoSettings) ? videoSettings.width / videoSettings.height : 16 / 9
    : validImageSettings(settings) ? frameAspect : 16 / 9;
  const transparentExport = imageExport && exportTab === "image" && settings.transparent;
  const imageSettings = snapshot?.render?.settings || defaultRenderSettings;
  const renderStale =
    !!snapshot?.render &&
    (snapshot.render.revisionId !== base ||
      JSON.stringify(imageSettings) !== JSON.stringify(settings) ||
      (!!cameraState &&
        ["position", "target", "up"].some((k) =>
          cameraState[k as "position"].some(
            (n, i) =>
              Math.abs(n - snapshot.render!.camera[k as "position"][i]) > 0.001,
          ),
        )));
  return (
    <div className={"workbench "+(recording?"is-recording ":"")+(renderView?"is-preview ":"")+(imageExport?"is-image-export":"")} style={{ "--output-aspect": compositionAspect } as CSSProperties}>
      <div className="editor-shell" inert={panel === "projects"}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ai-FormaDesk 首页" onClick={e=>{e.preventDefault();void openPanel("projects");}}>
          <span className="brand-mark">
            <img src="/app-icon.png" alt="" width={36} height={36} />
          </span>
          <span>Ai-FormaDesk</span>
        </a>
        <span className="divider" />
        <button
          className="project-trigger"
          onClick={() => void openPanel("projects")}
        >
          <span>{snapshot?.project.name || "选择或新建作品"}</span>
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
          <span>{busy ? "处理中" : base ? snapshot?.revision?.preview && snapshot.revision.preview.status !== "ready" ? "已保存 · 基础预览" : "已保存" : "空白项目"}</span>
        </span>
        <div className="top-actions">
          {snapshot && <BlenderLink key={pid} pid={pid} objectId={selected} base={base} busy={busy} onStartJob={startJob} onError={message => { if (isContext(pid, job?.id)) setError(message); }} />}
          {snapshot && <VisualReferences key={snapshot.project.id} jobs={[...(snapshot.jobs || []), ...(job?.visual ? [job] : [])]} current={snapshot.revision?.visual} />}
          <div className="history-controls" role="group" aria-label="撤销与重做">
          <button
            className="history-control"
            aria-label="撤销"
            title={base ? "撤销上一步" : "没有可撤销的操作"}
            disabled={busy || !base}
            onClick={() => void history("undo")}
          >
            <Undo2 size={18} />
          </button>
          <button
            className="history-control"
            aria-label="重做"
            title={snapshot?.project.redo.length ? "重做刚撤销的操作" : "没有可重做的操作"}
            disabled={busy || !snapshot?.project.redo.length}
            onClick={() => void history("redo")}
          >
            <Redo2 size={18} />
          </button>
          </div>
          <button
            className="button dark"
            disabled={!base}
            onClick={openImageExport}
          >
            <Download size={16} />
            导出
          </button>
        </div>
      </header>
      <main
        className="canvas-stage"
        aria-label="三维工作画布"
        onPointerDown={() => {if(!recording&&document.querySelector('.composer-wrap')?.getAttribute("data-moved")!=="true")setChatExpanded(false)}}
      >
        {imageExport && <CompositionToolbar disabled={busy || !!recording || previewStatus !== "ready"} onView={v => viewport.current?.view(v)} onReset={() => { if(entryCamera.current) viewport.current?.restoreCamera(entryCamera.current); }} />}
        <div className={"viewport-surface" + (transparentExport ? " transparent" : "")}>
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
            readOnly={renderView||!!recording||imageExport}
            hideGizmo={!!recording||imageExport}
            controlsEnabled={!imageExport || !busy}
            imageAspect={imageExport ? compositionAspect : undefined}
            transparentPreview={transparentExport}
            showGrid={!recording && !imageExport}
            onCameraChange={onCameraChange}
            frameAspect={imageExport ? undefined : recording?recording.width/recording.height:renderView ? frameAspect : undefined}
            onSelect={id=>{if(!recording&&!imageExport)selectObject(id)}}
            mode={mode}
            busy={busy}
            onTransform={(id, t) =>
              void command({ operation: "transform", transform: t }, id)
            }
            onReady={()=>{setPreviewRevision(base);setPreviewStatus('ready')}}
            onError={(message)=>{setError(message);setPreviewRevision(base);setPreviewStatus('failed')}}
          />
        )}
        </div>
        {imageExport && !recording && <p className="composition-canvas-hint"><span>{exportTab === "model" ? "完整场景预览 · 下载包含全部模型" : `${exportTab === "video" ? videoSettings.width : settings.width || "—"} × ${exportTab === "video" ? videoSettings.height : settings.height || "—"} · 画面内即为输出范围`}</span>拖动旋转 · 滚轮缩放 · 右键拖动平移</p>}
      </main>
      {imageExport && snapshot && <ExportPanel snapshot={snapshot} tab={exportTab} onTab={setExportTab} locked={!!recording} onClose={() => setImageExport(false)}>
        {exportTab === "image" && <ImageExport snapshot={snapshot} settings={settings} onSettings={setSettings} busy={busy} ready={previewRevision === base ? previewStatus : "loading"} job={job} error={error} stale={renderStale} onRender={() => void render()} onViewImage={() => setShowRender(true)} onReload={() => {setPreviewStatus("loading");setReloadKey(k=>k+1);}} />}
        {exportTab === "video" && <VideoExport key={pid} snapshot={{...snapshot, activeJob:job&&!terminal(job)?job:null}} settings={videoSettings} onSettings={setVideoSettings} recording={!!recording} ready={previewRevision===base?previewStatus:"loading"} onReload={()=>{setPreviewStatus("loading");setReloadKey(k=>k+1)}} busy={busy} onRecord={s=>setRecording({...s})} onRender={id => startJob(`videos/${id}/render`, {})} />}
      </ExportPanel>}
      {renderView && base && (
        <div className="preview-label glass">
          实时材质预览 · 拖动旋转
          {snapshot?.render && (
            <button onClick={() => setShowRender(true)}>查看成品图</button>
          )}
        </div>
      )}
      {renderView && base && (
        <div
          className="frame-guide"
          style={{
            width: `min(100vw, calc(100vh * ${frameAspect}))`,
            height: `min(100vh, calc(100vw / ${frameAspect}))`,
          }}
        >
          <span>
            {settings.width} × {settings.height}
          </span>
        </div>
      )}
      {showRender && snapshot?.render && (
        <RenderPreview
          key={snapshot.render.artifactId}
          render={snapshot.render}
          stale={renderStale}
          returnLabel={imageExport ? "返回取景页" : "返回工作台"}
          onClose={() => setShowRender(false)}
          onSettings={openImageExport}
        />
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
          disabled={!base}
          onClick={() => {setRenderView(true);setPanel("");setChatExpanded(false)}}
        >
          预览
        </button>
      </div>
      {!base && !busy && snapshot && (
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
          <p>聊聊想法，放入参考图，一起把细节想清楚。</p>
          <button
            className="example"
            onClick={() => {showChat();setPrompt("做一张木桌，桌上放一盏绿色台灯。")}}
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
          <button
            className={"tool " + (inspectorOpen && object ? "active" : "")}
            aria-label="对象属性"
            title="对象属性"
            disabled={!object}
            onClick={() => void openPanel("inspector")}
          >
            <Settings2 size={22} strokeWidth={1.6} />
          </button>
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
      {object && !renderView && inspectorOpen && (
        <Inspector
          key={object.id}
          object={object}
          busy={busy}
          onClose={() => setInspectorOpen(false)}
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
      {snapshot && (
        <Composer
          key={pid}
          snapshot={snapshot}
          busy={busy}
          job={job}
          preview={previewRevision===base?previewStatus:'loading'}
          disconnected={disconnected}
          onReload={()=>{setPreviewStatus('loading');setReloadKey(k=>k+1)}}
          aiReady={!healthStale && !!health?.codex?.ok}
          modelReady={!healthStale && !!health?.ok}
          selected={selected}
          expanded={chatExpanded}
          hidden={chatHidden}
          onHide={() => {setChatHidden(true);setChatExpanded(false)}}
          onExpanded={changeChatExpanded}
          onDiscuss={discuss}
          onBuild={(p) => void buildProposal(p)}
          onStop={() => {
            if (job)
              void api(`/jobs/${job.id}/cancel`, {}).catch((e) =>
                currentPid.current === pid && jobRef.current?.id === job.id && setError(e.message),
              );
          }}
          onHealth={() => void openPanel("health")}
          onError={message => { if (isContext(pid, job?.id)) setError(message); }}
          suggested={prompt}
          onRetryJob={id => { void startJob("retry", {}, id); }}
        />
      )}
      {snapshot && chatHidden && (
        <button className="chat-launcher glass" aria-label="打开创作对话" onClick={showChat}>
          {busy ? <Loader2 size={17} className="spin" /> : <MessageSquare size={17} />}
          <span>{busy ? "任务进行中" : chatUnread ? "有新回复" : "创作对话"}</span>
          {chatUnread && <i className="chat-unread" />}
        </button>
      )}
      <div className="bottom-left">
        <button
          className={"button glass " + (panel === "scene" ? "pressed" : "")}
          aria-expanded={panel === "scene"}
          aria-controls="scene-objects"
          onClick={() => void openPanel("scene")}
        >
          <Layers size={17} />
          场景 · {snapshot?.scene.objects.length || 0}
          <ChevronDown size={13} />
        </button>
        <button
          className="round glass"
          aria-label="版本历史"
          title="查看并恢复历史版本"
          disabled={!snapshot || busy}
          onClick={() => void openPanel("history")}
        >
          <History size={17} />
        </button>
      </div>
      <div className="bottom-right">
        <button
          className="round glass"
          aria-label="环境检查"
          onClick={() => void openPanel("health")}
        >
          <Settings2 size={18} />
          {(healthStale || (health && !health.ok)) && <i className="warning-dot" />}
        </button>
        <div className="view-picker glass">
          <select
            aria-label="观察视角"
            value={view}
            onChange={(e) => {
              setView(e.target.value);
              viewport.current?.view(e.target.value);
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
        <aside id="scene-objects" className="scene-popover glass" aria-label="场景对象">
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
                  onClick={() => selectObject(o.id)}
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
      </div>
      {panel === "projects" && (
        <ProjectLibrary
          currentId={pid}
          resumeId={resumeId}
          onOpen={(id) => {
            if(recording){setError("正在录制，请先保存或结束录制后再切换作品。");return;}
            setResumeId(id);
            currentPid.current = id;
            void api(`/projects/${id}/opened`,{}).catch(e=>{if(currentPid.current===id)setError(e.message)});
            setPid(id);
            setPanel("");
            setPrompt("");
          }}
          onClose={() => setPanel("")}
          onRemoved={(id) => {
            if (id === pid) setPid("");
            if (id === resumeId) {setResumeId("");localStorage.removeItem("forma-project");}
          }}
          onError={setError}
        />
      )}
      {recording&&base&&<VideoRecorder embedded pid={pid} base={base} settings={recording} viewport={viewport} onClose={()=>{setRecording(null);setExportTab('video')}} onReturnToWorkbench={()=>{setRecording(null);setImageExport(false);setExportTab('video')}} onSaved={()=>{void load(pid).catch(error=>{if(isContext(pid,job?.id))setError("刷新视频状态失败："+error.message)})}} onRender={id=>startJob(`videos/${id}/render`,{})}/>}
      {["history", "health"].includes(panel) && (
        <div className="modal-backdrop" onClick={() => setPanel("")}>
          <section
            ref={appModal}
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
                    history: "版本历史",
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
            {panel === "history" && (
              <>
                <p className="muted">
                  选择要恢复的版本。只想回到上一步，可点击顶部的“撤销”。
                </p>
                <div className="revision-list">
                  {[...revisions].reverse().map((r) => (
                    <div key={r.id} className={r.id === base ? "current" : ""}>
                      <span className="revision-dot" />
                      <div>
                        <strong>{r.label}</strong>
                        <small>
                          {shortDate(r.createdAt)} ·{" "}
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
            {panel === "health" && (
              <>
                {healthError && <p role="alert">{healthError} 上次检查结果已过期。</p>}
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
                  onClick={() => { void refreshHealth(true); }}
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
