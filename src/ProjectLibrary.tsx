import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Box,
  Check,
  Clock3,
  Download,
  Eye,
  FileBox,
  FolderOpen,
  Grid2X2,
  Heart,
  List,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { ProjectCover } from "./ProjectCover";
import { forgetProjectDraft } from "./Composer";
import { Viewport, type ViewportHandle } from "./Viewport";
import {
  filterLibrary,
  fileKindNames,
  type LibrarySort,
  type LibraryView,
  type ProjectFile,
  type ProjectFileKind,
} from "./libraryTypes";
import type { Project, Snapshot } from "./types";
import "./project-library.css";
import { tokenUsageLabel, tokenUsageTitle } from "./tokenUsage";
const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function ProjectLibrary({
  currentId,
  resumeId,
  onOpen,
  onClose,
  onRemoved,
  onError,
}: {
  currentId: string;
  resumeId?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
  onError: (e: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [section, setSection] = useState<"all" | "favorites" | "trash">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>(() => {
    const s = localStorage.getItem("forma-library-sort");
    return s === "name" || s === "created" ? s : "updated";
  });
  const [view, setView] = useState<LibraryView>(() =>
    localStorage.getItem("forma-library-view") === "list" ? "list" : "grid",
  );
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [menu, setMenu] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [name, setName] = useState("");
  const [undo, setUndo] = useState<Project | null>(null),
    [confirm, setConfirm] = useState<Project | null>(null);
  const [detail, setDetail] = useState<{
    id: string;
    tab: "files" | "preview";
  } | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [files, setFiles] = useState<ProjectFile[]>([]),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState("");
  const [media, setMedia] = useState<ProjectFile | null>(null),
    [retry, setRetry] = useState(0);
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [coverReady, setCoverReady] = useState(false);
  const [coverQueue, setCoverQueue] = useState<Project[]>([]);
  const coverProgress = useRef({ total: 0, done: 0, failed: 0 });
  function refreshCovers(targets: Project[]) {
    if (coverQueue.length || busy || !coverRefreshSupported) return;
    const eligible = targets.filter((p) => p.currentRevisionId && !p.activeJob);
    if (!eligible.length) {
      setNotice("没有可刷新的模型，请等待建模完成。");
      return;
    }
    coverProgress.current = { total: eligible.length, done: 0, failed: 0 };
    setError("");
    setNotice("");
    setCoverQueue(eligible);
  }
  function finishCover(message?: string) {
    const progress = coverProgress.current;
    progress.done++;
    if (message) {
      progress.failed++;
      setError(message);
    }
    setCoverQueue((queue) => queue.slice(1));
    if (progress.done === progress.total)
      setNotice(
        `封面刷新完成：${progress.total - progress.failed} 个成功${progress.failed ? `，${progress.failed} 个失败，可单独重试` : ""}。`,
      );
    void refresh(true);
  }
  const sequence = useRef(0),
    viewport = useRef<ViewportHandle>(null);
  const trash = section === "trash";
  const coverRefreshSupported =
    projects.length > 0 &&
    projects.every((p) => p.coverRefreshSupported === true);
  async function refresh(quiet = false) {
    const id = ++sequence.current;
    if (!quiet) setLoading(true);
    try {
      const ps = await api<Project[]>(`/projects${trash ? "?trash=1" : ""}`);
      if (id === sequence.current) {
        setProjects(ps);
        setError("");
      }
    } catch (e) {
      if (id === sequence.current) setError((e as Error).message);
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [trash]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(true), 15000);
    return () => clearInterval(timer);
  }, [trash]);
  useEffect(() => {
    localStorage.setItem("forma-library-sort", sort);
  }, [sort]);
  useEffect(() => {
    localStorage.setItem("forma-library-view", view);
  }, [view]);
  useEffect(() => {
    if (!detail) return;
    let alive = true;
    setDetailLoading(true);
    setDetailError("");
    setSnapshot(null);
    setFiles([]);
    setMedia(null);
    setCoverReady(false);
    const request =
      detail.tab === "preview"
        ? api<Snapshot>(`/projects/${detail.id}/scene`)
        : api<ProjectFile[]>(`/projects/${detail.id}/files`);
    void request
      .then((value) => {
        if (alive) {
          if (detail.tab === "preview") setSnapshot(value as Snapshot);
          else setFiles(value as ProjectFile[]);
        }
      })
      .catch((e) => {
        if (alive) setDetailError(e.message);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [detail?.id, detail?.tab, retry]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (confirm) setConfirm(null);
        else if (editing !== null) setEditing(null);
        else if (media) setMedia(null);
        else if (detail) setDetail(null);
        else if (menu) setMenu("");
        else if (currentId) onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [confirm, editing, media, detail, menu, currentId, onClose]);
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setMenu("");
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function open(id: string) {
    onOpen(id);
  }
  async function openBlender(p: Project) {
    await api(`/projects/${p.id}/blender/source`, {});
    setNotice(`已为“${p.name}”在 Blender 中打开源文件。`);
  }
  const visible = filterLibrary(projects, query, section === "favorites", sort);
  const resume =
    projects.find((p) => p.id === currentId) ||
    [...projects]
      .filter((p) => p.lastOpenedAt)
      .sort((a, b) => b.lastOpenedAt!.localeCompare(a.lastOpenedAt!))[0] ||
    projects.find((p) => p.id === resumeId);
  const detailProject = projects.find((p) => p.id === detail?.id);
  function cover(p: Project) {
    return p.coverUrl && !imageErrors[p.coverUrl] ? (
      <img
        src={p.coverUrl}
        alt={p.name}
        loading="lazy"
        onError={() =>
          setImageErrors((old) => ({ ...old, [p.coverUrl!]: true }))
        }
      />
    ) : (
      <span className="home-cover-placeholder">
        <Box size={36} strokeWidth={1} />
        <span>{p.currentRevisionId ? "暂无封面" : "尚未建模"}</span>
      </span>
    );
  }
  function changeSection(s: typeof section) {
    setSection(s);
    setQuery("");
    setMenu("");
  }
  return (
    <section className="project-home" aria-label="作品首页">
      {coverQueue[0] && (
        <ProjectCover
          key={coverQueue[0].id + ":" + coverQueue[0].currentRevisionId}
          project={coverQueue[0]}
          onSaved={() => finishCover()}
          onError={(message) =>
            finishCover(`${coverQueue[0].name}：${message}`)
          }
        />
      )}
      <aside className="home-sidebar">
        <a
          className="home-brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            changeSection("all");
          }}
        >
          <span>
            <Box size={24} />
          </span>
          <strong>
            FormaDesk<small>创作工作台</small>
          </strong>
        </a>
        <span className="home-nav-label">工作空间</span>
        <nav aria-label="作品分类">
          <button
            className={section === "all" ? "active" : ""}
            onClick={() => changeSection("all")}
          >
            <Grid2X2 size={18} />
            全部作品
          </button>
          <button
            className={section === "favorites" ? "active" : ""}
            onClick={() => changeSection("favorites")}
          >
            <Heart size={18} />
            我的收藏
          </button>
          <button
            className={section === "trash" ? "active" : ""}
            onClick={() => changeSection("trash")}
          >
            <Trash2 size={18} />
            回收站
          </button>
        </nav>
        <div className="home-sidebar-bottom">
          <span className="home-local-dot" />
          本机工作空间<small>模型与文件保存在这台 Mac 上</small>
        </div>
      </aside>
      <main className="home-main">
        <header className="home-header">
          <div>
            <span className="home-eyebrow">你的创作空间</span>
            <h1>
              {trash
                ? "回收站"
                : section === "favorites"
                  ? "我的收藏"
                  : "全部作品"}
            </h1>
            <p>
              {trash
                ? "移除的作品会保留在这里，随时可以恢复。"
                : "点击作品进入工作台，继续编辑与预览；源文件可单独在 Blender 中打开。"}
            </p>
          </div>
          <div className="home-header-actions">
            {currentId && (
              <button className="home-button" onClick={onClose}>
                <ArrowLeft size={16} />
                返回工作台
              </button>
            )}
            {!trash && (
              <button
                className="home-button primary"
                onClick={() => {
                  setEditing("");
                  setName("");
                }}
              >
                <Plus size={17} />
                新建作品
              </button>
            )}
          </div>
        </header>
        {!trash && resume && !query && section === "all" && (
          <button
            className="home-resume"
            disabled={busy}
            onClick={() => open(resume.id)}
          >
            <div className="resume-thumb">{cover(resume)}</div>
            <div>
              <span>
                <Clock3 size={13} />
                继续上次创作
              </span>
              <strong>{resume.name}</strong>
              <small>
                {resume.currentRevisionId
                  ? "回到工作台，继续编辑与预览"
                  : "继续描述你的创作想法"}
              </small>
            </div>
            <ArrowUpRight size={23} />
          </button>
        )}
        <div className="home-toolbar">
          <label className="home-search">
            <Search size={17} />
            <input
              aria-label="搜索作品"
              placeholder="搜索作品名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button aria-label="清除搜索" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
          <span className="home-count">{visible.length} 个作品</span>
          <label className="home-sort">
            排序
            <select
              aria-label="作品排序"
              value={sort}
              onChange={(e) => setSort(e.target.value as LibrarySort)}
            >
              <option value="updated">最近修改</option>
              <option value="created">创建时间</option>
              <option value="name">作品名称</option>
            </select>
          </label>
          <div className="home-view-switch" role="group" aria-label="显示方式">
            <button
              className={view === "grid" ? "active" : ""}
              aria-label="网格视图"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <Grid2X2 size={17} />
            </button>
            <button
              className={view === "list" ? "active" : ""}
              aria-label="列表视图"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={18} />
            </button>
          </div>
          <button
            className="home-button"
            aria-label="刷新作品"
            title="重新读取作品列表"
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} /> 刷新列表
          </button>
          {!trash && (
            <button
              className="home-button"
              disabled={busy || !!coverQueue.length || !coverRefreshSupported}
              onClick={() => refreshCovers(visible)}
              title="重新拍摄当前列表的模型封面，自动适应主体大小"
            >
              <RefreshCw
                size={16}
                className={coverQueue.length ? "spin" : ""}
              />{" "}
              刷新封面
            </button>
          )}
        </div>
        {projects.length > 0 && !coverRefreshSupported && (
          <div className="home-feedback">
            封面更新已安装，需要重新启动应用后生效。请先等待当前后台任务完成。
          </div>
        )}
        {!!coverQueue.length && (
          <div className="home-feedback" role="status">
            正在刷新封面 {coverProgress.current.done + 1} /{" "}
            {coverProgress.current.total} · {coverQueue[0].name}
          </div>
        )}
        {error && (
          <div className="home-feedback error" role="alert">
            {error}
            <button onClick={() => setError("")} aria-label="关闭提示">
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="home-feedback" role="status">
            {notice}
          </div>
        )}
        {undo && (
          <div className="home-feedback" role="status">
            “{undo.name}”已移入回收站
            <button
              onClick={() =>
                void action(async () => {
                  await api(`/projects/${undo.id}/untrash`, {});
                  setUndo(null);
                })
              }
            >
              撤销移除
            </button>
          </div>
        )}
        {loading ? (
          <div className="home-empty">
            <Loader2 className="spin" />
            正在加载作品…
          </div>
        ) : visible.length ? (
          <div className={`home-projects ${view}`}>
            {visible.map((p) => (
              <article
                key={p.id}
                className={`home-project ${p.id === currentId ? "current" : ""}`}
                aria-label={`作品 ${p.name}`}
              >
                <button
                  className="home-cover"
                  disabled={trash || busy}
                  aria-label={`打开 ${p.name}`}
                  onClick={() => open(p.id)}
                >
                  {cover(p)}
                  {p.id === currentId && (
                    <span className="home-current">
                      <Check size={11} />
                      正在编辑
                    </span>
                  )}
                </button>
                <div className="home-project-info">
                  <button
                    className="home-project-name"
                    title={p.name}
                    disabled={trash || busy}
                    onClick={() => open(p.id)}
                  >
                    {p.name}
                  </button>
                  <span className="home-project-meta">
                    {p.activeJob ? (
                      <span className="home-job">
                        <Loader2 size={11} className="spin" />
                        {p.activeJob.stage || "处理中"}
                      </span>
                    ) : p.currentRevisionId ? (
                      "已建模"
                    ) : (
                      "空白作品"
                    )}
                    <i /> {date(p.updatedAt || p.createdAt)}
                    <span className="home-project-tokens" title={tokenUsageTitle(p.tokenUsage)}>
                      <i /> {tokenUsageLabel(p.tokenUsage)}
                    </span>
                  </span>
                </div>
                <div className="home-project-actions">
                  {!trash ? (
                    <>
                      <button
                        className={`home-icon ${p.favorite ? "favorite" : ""}`}
                        aria-label={`${p.favorite ? "取消收藏" : "收藏"} ${p.name}`}
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api(
                              `/projects/${p.id}`,
                              { favorite: !p.favorite },
                              "PATCH",
                            );
                          })
                        }
                      >
                        <Heart
                          size={16}
                          fill={p.favorite ? "currentColor" : "none"}
                        />
                      </button>
                      <button
                        className="home-icon"
                        aria-label={`预览 ${p.name}`}
                        onClick={() => setDetail({ id: p.id, tab: "preview" })}
                      >
                        <Eye size={17} />
                      </button>
                      <button
                        className="home-icon"
                        aria-label={`查看文件 ${p.name}`}
                        onClick={() => setDetail({ id: p.id, tab: "files" })}
                      >
                        <FolderOpen size={17} />
                      </button>
                      <button
                        className="home-icon"
                        aria-label={`刷新封面 ${p.name}`}
                        title="刷新封面 · 自动适应模型主体"
                        disabled={
                          busy ||
                          !!coverQueue.length ||
                          !coverRefreshSupported ||
                          !p.currentRevisionId ||
                          !!p.activeJob
                        }
                        onClick={() => refreshCovers([p])}
                      >
                        <RefreshCw
                          size={16}
                          className={coverQueue[0]?.id === p.id ? "spin" : ""}
                        />
                      </button>
                      <button
                        className="home-icon"
                        aria-label={`管理 ${p.name}`}
                        aria-expanded={menu === p.id}
                        onClick={() => setMenu(menu === p.id ? "" : p.id)}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="home-button"
                        disabled={busy || !!p.cleanupState}
                        onClick={() =>
                          void action(async () => {
                            await api(`/projects/${p.id}/untrash`, {});
                          })
                        }
                      >
                        恢复
                      </button>
                      <button
                        className="home-icon danger"
                        aria-label={`彻底删除 ${p.name}`}
                        disabled={busy}
                        onClick={() => setConfirm(p)}
                      >
                        <Trash2 size={17} />
                      </button>
                    </>
                  )}
                </div>
                {menu === p.id && (
                  <div className="home-menu" role="menu">
                    <button
                      role="menuitem"
                      disabled={!p.currentRevisionId || !!p.activeJob || busy}
                      onClick={() => void action(() => openBlender(p))}
                    >
                      在 Blender 中打开源文件
                    </button>
                    <button role="menuitem" onClick={() => onOpen(p.id)}>
                      在工作台中打开
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setDetail({ id: p.id, tab: "files" });
                        setMenu("");
                      }}
                    >
                      查看作品文件
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setEditing(p.id);
                        setName(p.name);
                        setMenu("");
                      }}
                    >
                      重命名
                    </button>
                    <button
                      role="menuitem"
                      className="danger"
                      disabled={!!p.activeJob || busy}
                      onClick={() =>
                        void action(async () => {
                          await api(`/projects/${p.id}/trash`, {});
                          setUndo(p);
                          onRemoved(p.id);
                        })
                      }
                    >
                      移入回收站
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="home-empty">
            <FolderOpen size={40} strokeWidth={1} />
            <h2>
              {query
                ? "没有找到匹配作品"
                : trash
                  ? "回收站是空的"
                  : section === "favorites"
                    ? "还没有收藏作品"
                    : "从第一个作品开始"}
            </h2>
            <p>
              {query
                ? "试试其他名称，或清除搜索条件。"
                : section === "favorites"
                  ? "点击作品上的爱心，常用作品就会出现在这里。"
                  : trash
                    ? "移除的作品会显示在这里。"
                    : "新建一个作品，把想法变成模型。"}
            </p>
            {query ? (
              <button className="home-button" onClick={() => setQuery("")}>
                清除搜索
              </button>
            ) : (
              !trash &&
              section === "all" && (
                <button
                  className="home-button primary"
                  onClick={() => {
                    setEditing("");
                    setName("");
                  }}
                >
                  新建作品
                </button>
              )
            )}
          </div>
        )}
      </main>
      {detail && (
        <div className="home-drawer-backdrop" onClick={() => setDetail(null)}>
          <section
            className={`home-drawer ${detail.tab === "preview" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={detail.tab === "preview" ? "作品预览" : "作品文件"}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <small>
                  {detail.tab === "preview" ? "作品预览" : "作品文件"}
                </small>
                <h2>{detailProject?.name}</h2>
              </div>
              <button
                className="home-icon"
                aria-label="关闭作品详情"
                onClick={() => setDetail(null)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="home-detail-tabs">
              <button
                className={detail.tab === "preview" ? "active" : ""}
                onClick={() => setDetail({ ...detail, tab: "preview" })}
              >
                三维预览
              </button>
              <button
                className={detail.tab === "files" ? "active" : ""}
                onClick={() => setDetail({ ...detail, tab: "files" })}
              >
                作品文件
              </button>
            </div>
            {detailLoading ? (
              <div className="home-empty">
                <Loader2 className="spin" />
                正在加载…
              </div>
            ) : detailError ? (
              <div className="home-empty" role="alert">
                <p>{detailError}</p>
                <button
                  className="home-button"
                  onClick={() => setRetry((v) => v + 1)}
                >
                  重试加载
                </button>
              </div>
            ) : detail.tab === "preview" ? (
              <>
                <div className="home-model-preview">
                  {snapshot?.previewUrl ? (
                    <Viewport
                      ref={viewport}
                      key={detail.id}
                      url={snapshot.previewUrl}
                      scene={snapshot.scene}
                      selected={null}
                      onSelect={() => {}}
                      mode="select"
                      busy={false}
                      readOnly
                      onTransform={() => {}}
                      onError={setDetailError}
                      onReady={() => setCoverReady(true)}
                    />
                  ) : (
                    <div className="home-empty">
                      <Box size={36} />
                      <p>尚未建模</p>
                    </div>
                  )}
                </div>
                <footer>
                  <span>拖动旋转 · 滚轮缩放</span>
                  {detailProject?.currentRevisionId && (
                    <button
                      className="home-button"
                      disabled={
                        busy ||
                        !!coverQueue.length ||
                        !coverRefreshSupported ||
                        !!detailProject.activeJob
                      }
                      onClick={() => refreshCovers([detailProject])}
                    >
                      自动取景并刷新封面
                    </button>
                  )}
                  {snapshot?.previewUrl && (
                    <button
                      className="home-button"
                      disabled={!coverReady || busy || !coverRefreshSupported}
                      onClick={() =>
                        void action(async () => {
                          const image = viewport.current?.screenshot();
                          if (!image) throw new Error("预览尚未就绪");
                          await api(`/projects/${detail.id}/cover`, {
                            revisionId: snapshot.revision!.id,
                            image,
                            replace: true,
                          });
                          setNotice("作品封面已保存");
                        })
                      }
                    >
                      保存预览封面
                    </button>
                  )}
                  <button
                    className="home-button primary"
                    disabled={busy}
                    onClick={() => open(detail.id)}
                  >
                    进入工作台
                  </button>
                </footer>
              </>
            ) : (
              <div className="home-files">
                {files.length === 0 ? (
                  <div className="home-empty">
                    <FileBox size={36} />
                    <p>还没有生成文件</p>
                    <small>完成建模或导出后，文件会出现在这里。</small>
                  </div>
                ) : (
                  (Object.keys(fileKindNames) as ProjectFileKind[]).map(
                    (kind) => {
                      const group = files.filter((f) => f.kind === kind);
                      return (
                        group.length > 0 && (
                          <section className="home-file-group" key={kind}>
                            <h3>
                              {fileKindNames[kind]} <span>{group.length}</span>
                            </h3>
                            {group.map((f) => (
                              <article className="home-file" key={f.id}>
                                <span className={`home-file-format ${kind}`}>
                                  {f.format}
                                </span>
                                <div>
                                  <strong>{f.name}</strong>
                                  <small>
                                    {f.available
                                      ? `${size(f.size)} · ${date(f.createdAt)}`
                                      : "文件缺失"}
                                    {!f.current ? " · 较早版本" : ""}
                                  </small>
                                  <div className="home-file-actions">
                                    {(kind === "image" || kind === "video") && (
                                      <button
                                        disabled={!f.available}
                                        onClick={() => setMedia(f)}
                                      >
                                        {kind === "video" ? "播放" : "查看"}
                                      </button>
                                    )}
                                    {f.format === "BLEND" && (
                                      <button
                                        disabled={
                                          !f.available ||
                                          busy ||
                                          !!detailProject?.activeJob
                                        }
                                        onClick={() =>
                                          void action(async () => {
                                            await api(
                                              `/projects/${detail.id}/files/${f.id}/open`,
                                              {},
                                            );
                                            setNotice("已发送到 Blender");
                                          })
                                        }
                                      >
                                        在 Blender 中打开
                                      </button>
                                    )}
                                    {f.format === "GLB" && f.current && (
                                      <button
                                        disabled={!f.available}
                                        onClick={() =>
                                          setDetail({
                                            ...detail,
                                            tab: "preview",
                                          })
                                        }
                                      >
                                        预览模型
                                      </button>
                                    )}
                                    {f.available && (
                                      <a href={`${f.url}?download=1`} download>
                                        <Download size={12} />
                                        下载
                                      </a>
                                    )}
                                    <button
                                      disabled={!f.available || busy}
                                      onClick={() =>
                                        void action(async () => {
                                          await api(
                                            `/projects/${detail.id}/files/${f.id}/reveal`,
                                            {},
                                          );
                                          setNotice("已在访达中显示文件");
                                        })
                                      }
                                    >
                                      在访达中显示
                                    </button>
                                  </div>
                                </div>
                              </article>
                            ))}
                          </section>
                        )
                      );
                    },
                  )
                )}
              </div>
            )}
            {error && (
              <div className="home-feedback error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="home-feedback" role="status">
                {notice}
              </div>
            )}
          </section>
        </div>
      )}
      {media && (
        <div className="home-modal-backdrop" onClick={() => setMedia(null)}>
          <section
            className="home-media"
            role="dialog"
            aria-modal="true"
            aria-label={media.name}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <strong>{media.name}</strong>
              <button
                className="home-icon"
                aria-label="关闭媒体预览"
                onClick={() => setMedia(null)}
              >
                <X size={20} />
              </button>
            </header>
            {media.kind === "video" ? (
              <video
                src={media.url}
                controls
                autoPlay
                onError={() => setError("视频无法播放，请尝试下载查看")}
              />
            ) : (
              <img src={media.url} alt={media.name} />
            )}
          </section>
        </div>
      )}
      {editing !== null && (
        <div className="home-modal-backdrop">
          <form
            className="home-form"
            role="dialog"
            aria-modal="true"
            aria-label={editing ? "重命名作品" : "新建作品"}
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                if (editing)
                  await api(`/projects/${editing}`, { name }, "PATCH");
                else {
                  const p = await api<Project>("/projects", { name });
                  open(p.id);
                }
                setEditing(null);
              });
            }}
          >
            <h2>{editing ? "重命名作品" : "新建作品"}</h2>
            <label>
              作品名称
              <input
                autoFocus
                aria-label={editing ? "作品新名称" : "新作品名称"}
                placeholder="例如：重型摩托车"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button
                type="button"
                className="home-button"
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button
                className="home-button primary"
                disabled={busy || !name.trim()}
              >
                {editing ? "保存名称" : "创建作品"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {confirm && (
        <div className="home-modal-backdrop">
          <section
            className="home-form"
            role="alertdialog"
            aria-modal="true"
            aria-label="确认彻底删除"
          >
            <h2>彻底删除“{confirm.name}”？</h2>
            <p>
              此作品的模型、版本、图片、视频、对话和参考图将从工作台删除，无法恢复。
            </p>
            {error && <p role="alert">{error}</p>}
            <footer>
              <button className="home-button" onClick={() => setConfirm(null)}>
                保留作品
              </button>
              <button
                className="home-button danger-fill"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(
                      `/projects/${confirm.id}`,
                      { confirm: true },
                      "DELETE",
                    );
                    forgetProjectDraft(confirm.id);
                    if (undo?.id === confirm.id) setUndo(null);
                    setConfirm(null);
                  })
                }
              >
                确认彻底删除
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
