import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Box,
  Check,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { api } from "./api";
import { forgetProjectDraft } from "./Composer";
import { Viewport } from "./Viewport";
import { ProjectCover } from "./ProjectCover";
import type { Project, Snapshot } from "./types";
import { tokenUsageLabel, tokenUsageTitle } from "./tokenUsage";
export function ProjectLibrary({
  currentId,
  onOpen,
  onClose,
  onRemoved,
  onError,
}: {
  currentId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
  onError: (e: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [trash, setTrash] = useState(false),
    [loading, setLoading] = useState(true),
    [previewId, setPreviewId] = useState(""),
    [preview, setPreview] = useState<Snapshot | null>(null),
    [previewError, setPreviewError] = useState(""),
    [retry, setRetry] = useState(0),
    [menu, setMenu] = useState(""),
    [name, setName] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [confirm, setConfirm] = useState<Project | null>(null),
    [undo, setUndo] = useState<Project | null>(null),
    [mutating, setMutating] = useState(false);
  const sequence = useRef(0);
  const [coverErrors, setCoverErrors] = useState<Record<string, string>>({});
  const pendingCover =
    !trash && !previewId && !loading
      ? projects.find(
          (p) =>
            p.currentRevisionId &&
            !p.coverUrl &&
            !coverErrors[p.currentRevisionId],
        )
      : undefined;
  async function refresh() {
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const p = await api<Project[]>(`/projects${trash ? "?trash=1" : ""}`);
      if (seq === sequence.current) setProjects(p);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [trash]);
  useEffect(() => {
    if (!previewId) return;
    let alive = true;
    setPreview(null);
    setPreviewError("");
    void api<Snapshot>(`/projects/${previewId}/scene`)
      .then((s) => {
        if (alive) setPreview(s);
      })
      .catch((e) => {
        if (alive) setPreviewError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [previewId, retry]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (confirm) setConfirm(null);
        else if (previewId) setPreviewId("");
        else onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [confirm, previewId, onClose]);
  async function action(fn: () => Promise<void>) {
    if (mutating) return;
    setMutating(true);
    try {
      await fn();
      setMenu("");
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setMutating(false);
    }
  }
  return (
    <div className="modal-backdrop library-backdrop" onClick={onClose}>
      <section
        className="modal glass project-library"
        role="dialog"
        aria-modal="true"
        aria-label="作品库"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div className="library-title">
            {previewId && (
              <button
                className="icon"
                aria-label="返回作品库"
                onClick={() => setPreviewId("")}
              >
                <ArrowLeft size={20} />
              </button>
            )}
            <div>
              <h2>
                {previewId
                  ? preview?.project.name || "作品预览"
                  : trash
                    ? "回收站"
                    : "你的作品"}
              </h2>
              <p>
                {previewId
                  ? "自由转动看看，准备好后再继续创作。"
                  : trash
                    ? "作品和参考图片保留在这里，随时可以恢复。"
                    : "每个想法，都有自己的空间。"}
              </p>
            </div>
          </div>
          <button className="icon" aria-label="关闭作品库" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {previewId ? (
          <>
            <div className="library-preview" aria-label="作品临时预览">
              {previewError ? (
                <div className="library-empty">
                  <p>{previewError}</p>
                  <button
                    className="button"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    重试加载
                  </button>
                </div>
              ) : !preview ? (
                <Loader2 className="spin" />
              ) : !preview.previewUrl ? (
                <div className="library-empty">
                  <Box size={38} />
                  <p>尚未建模</p>
                  <small>打开作品，与 Codex 聊聊你的想法。</small>
                </div>
              ) : (
                <Viewport
                  key={`${previewId}-${retry}`}
                  url={preview.previewUrl}
                  scene={preview.scene}
                  selected={null}
                  onSelect={() => {}}
                  mode="select"
                  busy={false}
                  readOnly
                  onTransform={() => {}}
                  onError={setPreviewError}
                />
              )}
            </div>
            <footer className="library-preview-footer">
              <span>只读预览 · 拖动旋转，滚轮缩放</span>
              <button
                className="button dark"
                disabled={!preview}
                onClick={() => onOpen(previewId)}
              >
                打开编辑
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="library-toolbar">
              <button
                className={`button ${!trash ? "pressed" : ""}`}
                onClick={() => {
                  setTrash(false);
                  setEditing(null);
                }}
              >
                全部作品
              </button>
              <button
                className={`button ${trash ? "pressed" : ""}`}
                onClick={() => {
                  setTrash(true);
                  setEditing(null);
                }}
              >
                <Trash2 size={15} />
                回收站
              </button>
              {!trash && (
                <button
                  className="button dark new-work"
                  onClick={() => {
                    setEditing("");
                    setName("");
                  }}
                >
                  <Plus size={16} />
                  新建作品
                </button>
              )}
            </div>
            {editing !== null && (
              <form
                className="library-name-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action(async () => {
                    if (editing)
                      await api(`/projects/${editing}`, { name }, "PATCH");
                    else {
                      const p = await api<Project>("/projects", { name });
                      onOpen(p.id);
                    }
                    setEditing(null);
                  });
                }}
              >
                <input
                  autoFocus
                  aria-label={editing ? "作品新名称" : "新作品名称"}
                  placeholder="给想法起个名字"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
                <button
                  className="button dark"
                  disabled={!name.trim() || mutating}
                >
                  {editing ? "保存名称" : "创建作品"}
                </button>
                <button
                  type="button"
                  className="icon"
                  aria-label="取消命名"
                  onClick={() => setEditing(null)}
                >
                  <X size={16} />
                </button>
              </form>
            )}
            {undo && (
              <div className="library-undo">
                <span>“{undo.name}”已移入回收站</span>
                <button
                  disabled={mutating}
                  onClick={() =>
                    void action(async () => {
                      await api(`/projects/${undo.id}/untrash`, {});
                      setUndo(null);
                    })
                  }
                >
                  撤销
                </button>
              </div>
            )}
            {pendingCover && <p role="status">正在生成作品封面…</p>}
            {Object.keys(coverErrors).length > 0 && (
              <div role="status">
                <span>部分封面未能保存：{Object.values(coverErrors)[0]}</span>
                <button
                  className="button"
                  onClick={() => {
                    setCoverErrors({});
                    void refresh();
                  }}
                >
                  重试封面
                </button>
              </div>
            )}
            <div className="project-grid">
              {loading ? (
                <div className="library-empty">
                  <Loader2 className="spin" />
                </div>
              ) : projects.length ? (
                projects.map((p) => {
                  const cover = p.coverUrl;
                  return (
                    <article
                      className={`project-card ${currentId === p.id ? "current" : ""}`}
                      key={p.id}
                    >
                      <button
                        className="project-cover"
                        aria-label={`预览 ${p.name}`}
                        disabled={trash}
                        onClick={() => setPreviewId(p.id)}
                      >
                        {cover ? (
                          <img src={cover} alt={p.name} />
                        ) : (
                          <div className="project-placeholder">
                            <Box size={44} strokeWidth={1} />
                            <span>
                              {p.currentRevisionId
                                ? "封面待生成 · 点击预览"
                                : "想法待成形"}
                            </span>
                          </div>
                        )}
                        {currentId === p.id && (
                          <span className="current-work">
                            <Check size={12} />
                            正在编辑
                          </span>
                        )}
                      </button>
                      <div className="project-info">
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {new Date(
                              p.updatedAt || p.createdAt,
                            ).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            <span className="project-token-usage" title={tokenUsageTitle(p.tokenUsage)}>
                              {" · "}{tokenUsageLabel(p.tokenUsage)}
                            </span>
                            {p.activeJob && " · 正在处理"}
                            {p.cleanupState && " · 清理未完成"}
                          </small>
                        </div>
                        {!trash && (
                          <button
                            className="icon"
                            aria-label={`${p.name} 更多操作`}
                            onClick={() => setMenu(menu === p.id ? "" : p.id)}
                          >
                            <MoreHorizontal size={20} />
                          </button>
                        )}
                      </div>
                      {menu === p.id && (
                        <div className="project-menu">
                          <button
                            onClick={() => {
                              setEditing(p.id);
                              setName(p.name);
                              setMenu("");
                            }}
                          >
                            重命名
                          </button>
                          <button
                            className="danger-text"
                            disabled={!!p.activeJob || mutating}
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
                      {trash && (
                        <div className="trash-actions">
                          <button
                            className="button"
                            disabled={!!p.cleanupState || mutating}
                            onClick={() =>
                              void action(async () => {
                                await api(`/projects/${p.id}/untrash`, {});
                              })
                            }
                          >
                            <RotateCcw size={14} />
                            恢复
                          </button>
                          <button
                            className="button danger-text"
                            disabled={mutating}
                            onClick={() => setConfirm(p)}
                          >
                            <Trash2 size={14} />
                            {p.cleanupState ? "重试清理" : "彻底删除"}
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })
              ) : (
                <div className="library-empty">
                  <Box size={38} strokeWidth={1} />
                  <h3>{trash ? "回收站是空的" : "下一个作品，从这里开始"}</h3>
                  <p>
                    {trash
                      ? "移除的作品会保留在这里。"
                      : "点击“新建作品”，记录一个新想法。"}
                  </p>
                </div>
              )}
            </div>
          </>
        )}
        {confirm && (
          <div
            className="delete-confirm"
            role="alertdialog"
            aria-label="确认彻底删除"
          >
            <h3>彻底删除“{confirm.name}”？</h3>
            <p>
              此作品的模型、所有版本、渲染图、对话和参考图片都会从本机删除，无法恢复。
            </p>
            <div>
              <button
                className="button"
                disabled={mutating}
                onClick={() => setConfirm(null)}
              >
                保留作品
              </button>
              <button
                className="button danger-button"
                disabled={mutating}
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
                {mutating ? "正在清理…" : "确认彻底删除"}
              </button>
            </div>
          </div>
        )}
        {pendingCover && (
          <ProjectCover
            key={pendingCover.currentRevisionId}
            project={pendingCover}
            onSaved={(coverUrl) =>
              setProjects((items) =>
                items.map((p) =>
                  p.id === pendingCover.id &&
                  p.currentRevisionId === pendingCover.currentRevisionId
                    ? { ...p, coverUrl }
                    : p,
                ),
              )
            }
            onError={(error) =>
              setCoverErrors((errors) => ({
                ...errors,
                [pendingCover.currentRevisionId!]: error,
              }))
            }
          />
        )}
      </section>
    </div>
  );
}
