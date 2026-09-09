import { useChatLayout } from "./useChatLayout";
import { BuildProgress } from "./BuildProgress";
import { etaText } from "./progress";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowUp,
  ChevronDown,
  ImagePlus,
  Loader2,
  Square,
  X,
  Box,
  ArrowDown,
  Play,
  MessageSquare,
  RotateCw,
  Minus,
} from "lucide-react";
import { createPortal } from "react-dom";
import { api, uploadAttachment } from "./api";
import type { Attachment, Job, Proposal, Snapshot } from "./types";

type DraftImage = {
  key: string;
  file?: File;
  url: string;
  id?: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  error?: string;
};
type Draft = { text: string; images: DraftImage[] };
const drafts = new Map<string, Draft>();
const draftListeners = new Map<string, Set<() => void>>();
export function forgetProjectDraft(pid: string) {
  for (const image of drafts.get(pid)?.images || [])
    if (image.url.startsWith("blob:")) URL.revokeObjectURL(image.url);
  drafts.delete(pid);
  draftListeners.delete(pid);
}
const imageUrl = (pid: string, id: string) =>
  `/api/projects/${pid}/attachments/${id}`;
export function Composer({
  snapshot,
  busy,
  job,
  aiReady,
  modelReady,
  selected,
  expanded,
  hidden,
  onHide,
  onExpanded,
  onDiscuss,
  onBuild,
  onStop,
  onHealth,
  onError,
  suggested,
  preview,
  disconnected,
  onReload,
  onRetryJob,
}: {
  snapshot: Snapshot;
  busy: boolean;
  job: Job | null;
  aiReady: boolean;
  modelReady: boolean;
  selected: string | null;
  expanded: boolean;
  hidden: boolean;
  onHide: () => void;
  onExpanded: (v: boolean) => void;
  onDiscuss: (text: string, ids: string[]) => Promise<boolean>;
  onBuild: (p: Proposal) => void;
  onStop: () => void;
  onHealth: () => void;
  onError: (e: string) => void;
  suggested: string;
  preview: "loading" | "ready" | "failed";
  disconnected: boolean;
  onReload: () => void;
  onRetryJob?: (id: string) => void;
}) {
  const layout = useChatLayout(expanded);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const titlebar = useRef<HTMLElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = titlebar.current;
    const input = footer.current;
    if (!header || !input) return;
    const observer = new ResizeObserver(() => {
      if (!header.offsetHeight) return;
      layout.setCollapsedHeight(header.offsetHeight + input.scrollHeight + 2);
    });
    observer.observe(header);
    observer.observe(input);
    return () => observer.disconnect();
  }, []);
  const [flow, setFlow] = useState(false);
  const [time, setTime] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const buildJob =
    job && ["generate", "preview"].includes(job.type)
      ? job
      : [...(snapshot.jobs || [])]
          .reverse()
          .find((j) => ["generate", "preview"].includes(j.type)) || null;
  useEffect(() => {
    if (
      buildJob &&
      ["queued", "running", "failed", "cancelled"].includes(buildJob.status)
    ) {
      setFlow(true);
      onExpanded(true);
    }
  }, [buildJob?.id]);
  useEffect(() => {
    if (buildJob?.status === "succeeded" && preview === "ready") setFlow(false);
  }, [buildJob?.status, preview]);
  const retry = () => {
    if (buildJob?.request || buildJob?.type === "preview") {
      onRetryJob?.(buildJob.id);
      return;
    }
    const p = [...(snapshot.proposals || [])]
      .reverse()
      .find(
        (p) =>
          p.jobId === buildJob?.id && ["failed", "ready"].includes(p.status),
      );
    if (p) onBuild(p);
  };
  const pid = snapshot.project.id;
  if (!drafts.has(pid)) drafts.set(pid, { text: "", images: [] });
  const draft = useSyncExternalStore(
    (listener) => {
      if (!draftListeners.has(pid)) draftListeners.set(pid, new Set());
      draftListeners.get(pid)!.add(listener);
      return () => {
        draftListeners.get(pid)?.delete(listener);
      };
    },
    () => drafts.get(pid)!,
  );
  const current = useRef(draft);
  current.current = draft;
  const [lightbox, setLightbox] = useState<string | null>(null),
    [newReply, setNewReply] = useState(false),
    [dragOver, setDragOver] = useState(false);
  const list = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    chooser = useRef<HTMLInputElement>(null);
  const update = (fn: (d: Draft) => Draft) => {
    const next = fn(drafts.get(pid) || current.current);
    drafts.set(pid, next);
    current.current = next;
    draftListeners.get(pid)?.forEach((listener) => listener());
  };
  useEffect(() => {
    if (suggested) {
      update((d) => ({ ...d, text: suggested }));
      onExpanded(true);
    }
  }, [suggested]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(160, Math.max(48, textarea.current.scrollHeight)) + "px";
    }
  }, [draft.text, layout.layout.width]);
  const messageVersion = snapshot.messages
    .map((m) => `${m.id}:${m.status}:${m.text}`)
    .join("\n");
  useEffect(() => {
    if (nearBottom.current)
      requestAnimationFrame(() =>
        list.current?.scrollTo({
          top: list.current.scrollHeight,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        }),
      );
    else setNewReply(true);
  }, [messageVersion]);
  useEffect(() => {
    if (expanded && nearBottom.current)
      requestAnimationFrame(() =>
        list.current?.scrollTo({ top: list.current.scrollHeight }),
      );
  }, [expanded]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightbox) setLightbox(null);
        else onExpanded(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [lightbox, onExpanded]);
  async function upload(item: DraftImage) {
    update((d) => ({
      ...d,
      images: d.images.map((a) =>
        a.key === item.key
          ? { ...a, status: "uploading", error: undefined }
          : a,
      ),
    }));
    try {
      const a = await uploadAttachment<Attachment>(pid, item.file!);
      const stillPresent = drafts
        .get(pid)
        ?.images.some((i) => i.key === item.key);
      if (!stillPresent) {
        await api(`/projects/${pid}/attachments/${a.id}`, undefined, "DELETE");
        return;
      }
      update((d) => ({
        ...d,
        images: d.images.map((i) =>
          i.key === item.key
            ? { ...i, id: a.id, status: "ready", url: imageUrl(pid, a.id) }
            : i,
        ),
      }));
      if (item.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
    } catch (e) {
      if (!drafts.has(pid)) return;
      update((d) => ({
        ...d,
        images: d.images.map((i) =>
          i.key === item.key
            ? { ...i, status: "failed", error: (e as Error).message }
            : i,
        ),
      }));
    }
  }
  function addFiles(files: File[]) {
    const next = [...current.current.images];
    const added: DraftImage[] = [];
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        onError("仅支持 PNG、JPEG、WebP 图片");
        continue;
      }
      if (
        file.size > 10 * 1024 * 1024 ||
        next.length >= 6 ||
        next.reduce((n, a) => n + a.size, 0) + file.size > 40 * 1024 * 1024
      ) {
        onError("最多 6 张图片，单张 10 MB、合计 40 MB");
        continue;
      }
      const a: DraftImage = {
        key: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
        status: "uploading",
      };
      next.push(a);
      added.push(a);
    }
    update((d) => ({ ...d, images: next }));
    onExpanded(true);
    added.forEach((a) => void upload(a));
  }
  async function remove(a: DraftImage) {
    try {
      if (a.id)
        await api(`/projects/${pid}/attachments/${a.id}`, undefined, "DELETE");
      update((d) => ({
        ...d,
        images: d.images.filter((i) => i.key !== a.key),
      }));
      if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  const canSend =
    !!(draft.text.trim() || draft.images.length) &&
    draft.images.every((i) => i.status === "ready") &&
    !busy &&
    aiReady;
  async function send() {
    if (!canSend) return;
    nearBottom.current = true;
    onExpanded(true);
    if (
      await onDiscuss(
        draft.text,
        draft.images.map((a) => a.id!),
      )
    )
      update(() => ({ text: "", images: [] }));
  }
  const object = snapshot.scene.objects.find((o) => o.id === selected);
  return (
    <section
      className={`composer-wrap ${expanded ? "expanded" : "compact"} ${hidden ? "is-hidden" : ""} ${dragOver ? "drag-over" : ""}`}
      style={layout.style}
      data-moved={layout.layout.moved}
      data-dragging={layout.dragging}
      aria-label="AI 创作对话"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!busy) addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="composer glass">
        <header className="chat-titlebar" ref={titlebar}>
          <button
            className="chat-handle"
            aria-label="移动创作对话"
            onPointerDown={(e) => layout.start(e)}
            onClick={() => {
              if (!layout.moved.current) onExpanded(!expanded);
            }}
          >
            <MessageSquare size={18} />
            <span>创作对话</span>
            {!expanded && !!draft.images.length && (
              <small>{draft.images.length} 张参考图</small>
            )}
            {!expanded && busy && (
              <small title={job ? etaText(job, time) : undefined}>
                {job?.stage} · {job ? etaText(job, time) : ""}
              </small>
            )}
          </button>
          <div className="chat-title-actions">
            {expanded && (
              <button
                className="icon"
                title="恢复默认布局"
                aria-label="恢复默认布局"
                onClick={layout.reset}
              >
                <RotateCw size={14} />
              </button>
            )}
            <button
              className="icon"
              aria-label={expanded ? "收起创作对话" : "展开创作对话"}
              aria-expanded={expanded}
              title={expanded ? "收起为小输入栏" : "展开创作对话"}
              onClick={() => onExpanded(!expanded)}
            >
              <ChevronDown size={16} className={expanded ? "" : "flipped"} />
            </button>
            <button
              className="icon"
              aria-label="隐藏创作对话"
              title="隐藏创作对话，保留草稿和任务"
              onClick={onHide}
            >
              <Minus size={16} />
            </button>
          </div>
        </header>
        <div
          className="conversation-reveal"
          aria-hidden={!expanded}
          inert={!expanded}
        >
          {flow && buildJob ? (
            <BuildProgress
              job={buildJob}
              preview={preview}
              disconnected={disconnected}
              onRetry={retry}
              onReload={onReload}
              onStop={onStop}
              onChat={() => setFlow(false)}
            />
          ) : (
            <div
              className="conversation-scroll"
              ref={list}
              tabIndex={0}
              onWheel={(e) => {
                if (e.deltaY < 0) nearBottom.current = false;
              }}
              onTouchMove={() => {
                nearBottom.current = false;
              }}
              onKeyDown={(e) => {
                if (["PageUp", "Home", "ArrowUp"].includes(e.key))
                  nearBottom.current = false;
              }}
              onScroll={() => {
                const el = list.current!;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 70) {
                  nearBottom.current = true;
                  setNewReply(false);
                }
              }}
            >
              {buildJob && (
                <button className="flow-summary" onClick={() => setFlow(true)}>
                  {buildJob.status === "succeeded"
                    ? "✓ 建模记录"
                    : buildJob.stage}{" "}
                  · 查看流程与耗时
                </button>
              )}
              {!snapshot.messages.length && (
                <div className="chat-welcome">
                  <Box size={26} strokeWidth={1.2} />
                  <h3>先聊想法，再让它成形。</h3>
                  <p>
                    发一张参考图，或说说还没想清楚的细节。
                    <br />
                    明确说出按图建模后，会自动生成三视图并检查模型。
                  </p>
                </div>
              )}
              {snapshot.messages.map((m) => (
                <article
                  className={`conversation-message ${m.role}`}
                  key={m.id}
                >
                  <small>
                    {m.role === "user"
                      ? "你"
                      : m.role === "error"
                        ? "执行反馈"
                        : "Codex"}
                  </small>
                  {!!m.attachmentIds?.length && (
                    <div className="message-images">
                      {m.attachmentIds.map((id, i) => (
                        <button
                          key={id}
                          onClick={() => setLightbox(imageUrl(pid, id))}
                        >
                          <img src={imageUrl(pid, id)} alt={`图 ${i + 1}`} />
                          <span>图 {i + 1}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {m.status === "pending" ? (
                    <p className="thinking">
                      <Loader2 size={14} className="spin" />
                      {job?.stage || "正在思考…"}
                    </p>
                  ) : (
                    <p>{m.text}</p>
                  )}
                  {m.proposalId &&
                    (() => {
                      const p = snapshot.proposals?.find(
                        (p) => p.id === m.proposalId,
                      );
                      if (!p) return null;
                      const usable =
                        ["ready", "failed"].includes(p.status) &&
                        p.baseRevisionId === snapshot.project.currentRevisionId;
                      return (
                        <div className="proposal-card">
                          <small>建模方案</small>
                          <h3>{p.title}</h3>
                          <p>{p.description}</p>
                          {!!p.attachmentIds.length && (
                            <div className="proposal-images">
                              {p.attachmentIds.map((id, i) => (
                                <button
                                  key={id}
                                  onClick={() => setLightbox(imageUrl(pid, id))}
                                >
                                  <img
                                    src={imageUrl(pid, id)}
                                    alt={`方案参考图 ${i + 1}`}
                                  />
                                </button>
                              ))}
                            </div>
                          )}
                          <button
                            className="button dark"
                            disabled={!usable || busy || !modelReady}
                            onClick={() => onBuild(p)}
                          >
                            <Play size={14} />
                            {p.status === "succeeded"
                              ? "已完成"
                              : p.status === "running"
                                ? "正在建模"
                                : !usable
                                  ? "方案已过期，请继续讨论"
                                  : p.status === "failed"
                                    ? "重试建模"
                                    : p.baseRevisionId
                                      ? "应用修改"
                                      : "开始建模"}
                          </button>
                        </div>
                      );
                    })()}
                </article>
              ))}
            </div>
          )}
          {newReply && !flow && (
            <button
              className="new-reply"
              onClick={() => {
                nearBottom.current = true;
                setNewReply(false);
                list.current?.scrollTo({
                  top: list.current.scrollHeight,
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "instant"
                    : "smooth",
                });
              }}
            >
              <ArrowDown size={12} />
              有新回复
            </button>
          )}
        </div>
        <div className="composer-footer" ref={footer}>
          <div className="context-line">
            <span className="context-text">
              {busy
                ? disconnected
                  ? "正在重新连接"
                  : job?.stage || "正在提交…"
                : object
                  ? `正在讨论：${object.name}`
                  : "先讨论想法，确认方案后再建模。"}
            </span>
            {busy && <Loader2 size={14} className="spin" />}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {!!draft.images.length && (
              <div className="draft-images">
                {draft.images.map((a, i) => (
                  <div className={`draft-image ${a.status}`} key={a.key}>
                    <button type="button" onClick={() => setLightbox(a.url)}>
                      <img src={a.url} alt={`待发送图 ${i + 1}`} />
                    </button>
                    <span>图 {i + 1}</span>
                    <button
                      type="button"
                      className="remove-image"
                      aria-label={`移除图 ${i + 1}`}
                      disabled={busy}
                      onClick={() => void remove(a)}
                    >
                      <X size={12} />
                    </button>
                    {a.status === "uploading" && (
                      <Loader2 size={16} className="upload-indicator spin" />
                    )}
                    {a.status === "failed" && (
                      <button
                        type="button"
                        className="retry-upload"
                        title={a.error}
                        onClick={() => void upload(a)}
                      >
                        <RotateCw size={12} />
                        重试
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textarea}
              aria-label="创作想法"
              value={draft.text}
              placeholder="说说你的想法，或添加参考图片…"
              onFocus={() => onExpanded(true)}
              onChange={(e) => update((d) => ({ ...d, text: e.target.value }))}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={busy}
              rows={2}
            />
            <div className="composer-bottom">
              <input
                ref={chooser}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                aria-label="选择参考图片"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files || []));
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="icon"
                aria-label="添加图片"
                title="添加图片，也可以拖入或粘贴"
                disabled={busy || draft.images.length >= 6}
                onClick={() => chooser.current?.click()}
              >
                <ImagePlus size={20} />
              </button>
              <button
                type="button"
                className="model-badge"
                title="查看 Codex 连接状态"
                onClick={onHealth}
              >
                <span className={`status-dot ${aiReady ? "ok" : ""}`} />
                Codex
              </button>
              <span className="input-hint">
                Enter 讨论 · Shift + Enter 换行
              </span>
              {busy ? (
                <button
                  type="button"
                  className="send stop"
                  aria-label="停止任务"
                  onClick={onStop}
                >
                  <Square size={17} />
                </button>
              ) : (
                <button
                  className="send"
                  aria-label="发送讨论"
                  disabled={!canSend}
                >
                  <ArrowUp size={23} />
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
      {expanded &&
        ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => (
          <div
            key={edge}
            role="separator"
            aria-label={`调整聊天窗口 ${edge}`}
            className={`chat-resize ${edge}`}
            onPointerDown={(e) => layout.start(e, edge)}
          />
        ))}
      {lightbox &&
        createPortal(
          <div
            className="image-lightbox"
            role="dialog"
            aria-label="参考图片大图"
            onClick={() => setLightbox(null)}
          >
            <button
              className="round glass"
              aria-label="关闭图片"
              onClick={() => setLightbox(null)}
            >
              <X />
            </button>
            <img
              src={lightbox}
              alt="参考图片大图"
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body,
        )}
    </section>
  );
}
