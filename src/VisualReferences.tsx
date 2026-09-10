import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Download,
  FileBox,
  Image as ImageIcon,
  Images,
  Info,
  Maximize2,
  X,
} from "lucide-react";
import type { Job } from "./types";
import type { VisualEvidence, VisualJobState } from "./visualTypes";
import "./visual-references.css";

const categories = [
  ["references", "原图与三视图"],
  ["renders", "模型检查图"],
  ["textures", "材质贴图"],
  ["all", "全部图片"],
] as const;
const isReference = (e: VisualEvidence) =>
  e.label.startsWith("原图") || e.label.includes("参考图");
function imageTitle(label: string) {
  const names: Record<string, string> = {
    正面: "正视图",
    右侧: "右视图",
    左侧: "左视图",
    顶部: "俯视图",
    背面: "后视图",
    底部: "仰视图",
  };
  for (const [name, title] of Object.entries(names))
    if (label.startsWith(name + "参考图")) return title;
  return label.replace(/\s*·\s*单轮$/, "");
}
const imageUrl = (e: VisualEvidence) => `/api/artifacts/${e.artifactId}`;

function ReferenceCard({
  item,
  onOpen,
}: {
  item: VisualEvidence;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.artifactId]);
  return (
    <button
      className="visual-image-card"
      onClick={onOpen}
      aria-label={item.label}
      title={`放大查看 · ${item.label}`}
    >
      <div className="visual-image-canvas">
        {failed ? (
          <span className="visual-missing">
            <ImageIcon size={24} />
            图片暂时无法加载
          </span>
        ) : (
          <img
            src={imageUrl(item)}
            alt={item.label}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
        <span className="visual-zoom">
          <Maximize2 size={15} />
        </span>
      </div>
      <span className="visual-card-caption">
        <strong>{imageTitle(item.label)}</strong>
        <span>
          {item.label.startsWith("原图")
            ? "原始图片"
            : item.label.includes("参考图")
              ? "AI 生成"
              : "查看大图"}
        </span>
      </span>
    </button>
  );
}

export function VisualReferences({
  jobs,
  current,
}: {
  jobs: Job[];
  current?: VisualJobState;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [large, setLarge] = useState<VisualEvidence | null>(null);
  const [filter, setFilter] = useState<string>("references");
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const states = new Map<string, VisualJobState>();
  for (const j of jobs) if (j.visual) states.set(j.visual.runId, j.visual);
  if (current && !states.has(current.runId)) states.set(current.runId, current);
  const runs = [...states.values()].reverse();
  const state = runs.find((r) => r.runId === selected) || runs[0];
  const job = [...jobs].reverse().find((j) => j.visual?.runId === state?.runId);
  const allImages = state?.evidence.filter((e) => e.kind === "image") || [];
  const matching = (e: VisualEvidence, category: string) =>
    category === "all" ||
    (category === "references"
      ? isReference(e)
      : category === "textures"
        ? /贴图|纹理/.test(e.label)
        : e.label.includes("检查"));
  const images = allImages.filter((e) => matching(e, filter));
  const originals = images.filter((e) => e.label.startsWith("原图"));
  const views = images.filter((e) => !e.label.startsWith("原图"));
  const files = state?.evidence.filter((e) => e.kind !== "image") || [];
  const largeIndex = large
    ? images.findIndex((e) => e.artifactId === large.artifactId)
    : -1;
  const busy = job?.status === "running" || job?.status === "queued";
  function close() {
    setLarge(null);
    setOpen(false);
  }
  function moveImage(direction: number) {
    if (images.length > 1)
      setLarge(
        images[(largeIndex + direction + images.length) % images.length],
      );
  }
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const root = document.getElementById("root");
    const previousInert = root?.inert;
    document.body.style.overflow = "hidden";
    if (root) root.inert = true;
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (root) root.inert = previousInert || false;
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!large) return;
    const previous = document.activeElement as HTMLElement | null;
    document
      .querySelector<HTMLButtonElement>(".visual-lightbox-close")
      ?.focus();
    return () => previous?.focus();
  }, [!!large]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const panel = document.querySelector(
          large ? ".visual-lightbox" : ".visual-reference-panel",
        );
        const controls = [
          ...(panel?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,a[href],summary",
          ) || []),
        ].filter((el) => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (
          first &&
          last &&
          (!panel?.contains(document.activeElement) ||
            (e.shiftKey
              ? document.activeElement === first
              : document.activeElement === last))
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
      if (
        ["w", "e", "r", "f", "delete", "backspace"].includes(
          e.key.toLowerCase(),
        ) ||
        ((e.metaKey || e.ctrlKey) && ["z", "y"].includes(e.key.toLowerCase()))
      )
        e.stopImmediatePropagation();
      if (large && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        moveImage(e.key === "ArrowLeft" ? -1 : 1);
      }
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (large) setLarge(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, large, images]);

  const cards = (items: VisualEvidence[]) => (
    <div className="visual-image-grid">
      {items.map((item) => (
        <ReferenceCard
          key={item.artifactId}
          item={item}
          onOpen={() => setLarge(item)}
        />
      ))}
    </div>
  );
  return (
    <>
      <button
        ref={trigger}
        className="button"
        disabled={!state}
        title={!state ? "提交图片建模后，可在这里查看原图和三视图" : undefined}
        onClick={() => setOpen(true)}
      >
        参考与三视图
      </button>
      {open &&
        state &&
        createPortal(
          <div
            className="visual-reference-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <section
              className="visual-reference-panel"
              role="dialog"
              aria-modal="true"
              aria-label="参考与三视图"
              aria-describedby="visual-reference-description"
              inert={!!large}
            >
              <header className="visual-reference-header">
                <div className="visual-reference-heading">
                  <span className="visual-heading-icon">
                    <Images size={21} strokeWidth={1.6} />
                  </span>
                  <div>
                    <h2>参考与三视图</h2>
                    <p id="visual-reference-description">
                      从原始图片到多角度参考，随时对照细节。
                    </p>
                  </div>
                </div>
                <button
                  ref={closeButton}
                  className="visual-icon-button"
                  aria-label="关闭"
                  onClick={close}
                >
                  <X size={20} />
                </button>
              </header>
              <div className="visual-reference-toolbar">
                <div
                  className="visual-filters"
                  role="group"
                  aria-label="查看内容"
                >
                  {categories.map(([key, label]) => (
                    <button
                      key={key}
                      aria-pressed={filter === key}
                      onClick={() => setFilter(key)}
                    >
                      {label}
                      <span>
                        {allImages.filter((e) => matching(e, key)).length}
                      </span>
                    </button>
                  ))}
                </div>
                {runs.length > 1 && (
                  <label className="visual-run-select">
                    <span>建模记录</span>
                    <select
                      aria-label="建模记录"
                      value={state.runId}
                      onChange={(e) => {
                        setSelected(e.target.value);
                        setLarge(null);
                      }}
                    >
                      {runs.map((r, i) => (
                        <option key={r.runId} value={r.runId}>
                          第 {runs.length - i} 次建模
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} />
                  </label>
                )}
              </div>
              <div className="visual-reference-body">
                <div className="visual-context-line">
                  <span>
                    <Info size={14} />
                    生成视图包含 AI 推测，原图始终保留。
                  </span>
                  <span
                    className={`visual-run-status${job?.error ? " is-failed" : ""}`}
                    role="status"
                  >
                    <i />
                    {busy
                      ? state.phase
                      : job?.error
                        ? "本次建模未完成"
                        : "参考资料已保存"}
                  </span>
                </div>
                {job?.error && (
                  <div className="visual-failure" role="alert">
                    {job.error}
                  </div>
                )}
                {images.length ? (
                  filter === "references" ? (
                    <div
                      className={`visual-reference-comparison${!originals.length || !views.length ? " is-single" : ""}`}
                    >
                      {!!originals.length && (
                        <section className="visual-originals">
                          <div className="visual-group-heading">
                            <h3>原始参考</h3>
                            <span>{originals.length} 张上传图片</span>
                          </div>
                          {cards(originals)}
                        </section>
                      )}
                      {!!views.length && (
                        <section className="visual-generated">
                          <div className="visual-group-heading">
                            <h3>三视图</h3>
                            <span>AI 生成的多角度参考</span>
                          </div>
                          {cards(views)}
                        </section>
                      )}
                    </div>
                  ) : (
                    <div className="visual-gallery-all">{cards(images)}</div>
                  )
                ) : (
                  <div className="visual-empty">
                    <Images size={30} strokeWidth={1.25} />
                    <strong>
                      暂无{categories.find(([key]) => key === filter)?.[1]}
                    </strong>
                    <span>
                      {busy
                        ? "图片生成后会自动出现在这里。"
                        : "当前建模记录没有这类图片，可以切换其他分类查看。"}
                    </span>
                  </div>
                )}
                <div className="visual-reference-notes">
                  {!!state.assumptions.length && (
                    <details>
                      <summary>
                        <Info size={16} />
                        <span>不可见结构的假设</span>
                        <em>{state.assumptions.length} 项说明</em>
                        <ChevronDown size={15} />
                      </summary>
                      <ul>
                        {state.assumptions.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {!!state.reviews.length && (
                    <details>
                      <summary>
                        <Info size={16} />
                        <span>AI 检查记录（不代表人工验收）</span>
                        <em>{state.reviews.length} 条记录</em>
                        <ChevronDown size={15} />
                      </summary>
                      {state.reviews.map((r, i) => (
                        <article key={i}>
                          <strong>
                            {r.phase} · 第 {r.round + 1} 次 ·{" "}
                            {r.result.acceptable ? "AI 判断通过" : "需要修正"}
                          </strong>
                          <ul>
                            {[
                              ...r.result.shapeIssues,
                              ...r.result.textureIssues,
                              ...r.result.lightingIssues,
                            ].map((s, n) => (
                              <li key={n}>{s}</li>
                            ))}
                          </ul>
                          <p>{r.result.repair}</p>
                        </article>
                      ))}
                    </details>
                  )}
                  <details>
                    <summary>
                      <FileBox size={16} />
                      <span>模型与过程文件</span>
                      <em>{files.length} 个文件</em>
                      <ChevronDown size={15} />
                    </summary>
                    <div className="visual-file-list">
                      {files.length ? (
                        files.map((e) => (
                          <a key={e.artifactId} href={imageUrl(e)} download>
                            <FileBox size={15} />
                            <span>{e.label}</span>
                            <Download size={14} />
                          </a>
                        ))
                      ) : (
                        <p>本次记录暂无可下载的过程文件。</p>
                      )}
                    </div>
                  </details>
                </div>
              </div>
              <footer className="visual-reference-footer">
                <span>{images.length} 张图片</span>
                <span>
                  <Maximize2 size={12} />
                  点击图片放大查看
                </span>
              </footer>
            </section>
          </div>,
          document.body,
        )}
      {large &&
        createPortal(
          <div
            className="visual-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={large.label}
            onClick={(e) => {
              if (e.target === e.currentTarget) setLarge(null);
            }}
          >
            <header>
              <div>
                <strong>{imageTitle(large.label)}</strong>
                <span>
                  {largeIndex + 1} / {images.length}
                </span>
              </div>
              <div>
                <a
                  className="visual-lightbox-download"
                  href={imageUrl(large)}
                  download
                  aria-label="下载图片"
                >
                  <Download size={17} />
                  下载图片
                </a>
                <button
                  className="visual-icon-button visual-lightbox-close"
                  aria-label="关闭大图"
                  onClick={() => setLarge(null)}
                >
                  <X size={21} />
                </button>
              </div>
            </header>
            <button
              className="visual-lightbox-prev"
              aria-label="上一张图片"
              disabled={images.length < 2}
              onClick={() => moveImage(-1)}
            >
              <ArrowLeft size={24} />
            </button>
            <img
              key={large.artifactId}
              src={imageUrl(large)}
              alt={large.label}
            />
            <button
              className="visual-lightbox-next"
              aria-label="下一张图片"
              disabled={images.length < 2}
              onClick={() => moveImage(1)}
            >
              <ArrowRight size={24} />
            </button>
            <p className="visual-lightbox-hint">
              ← → 切换图片<span>Esc 关闭</span>
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
