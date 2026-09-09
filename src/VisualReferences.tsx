import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Job } from "./types";
import type { VisualJobState } from "./visualTypes";
import "./visual-references.css";

export function VisualReferences({
  jobs,
  current,
}: {
  jobs: Job[];
  current?: VisualJobState;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [large, setLarge] = useState<{ url: string; label: string } | null>(
    null,
  );
  const [filter, setFilter] = useState("references");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const panel = document.querySelector(
          large ? ".visual-lightbox" : ".visual-reference-panel",
        );
        const controls = [
          ...(panel?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select,a[href]",
          ) || []),
        ];
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
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (large) setLarge(null);
        else setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, large]);
  const states = new Map<string, VisualJobState>();
  for (const j of jobs) if (j.visual) states.set(j.visual.runId, j.visual);
  if (current) states.set(current.runId, current);
  const runs = [...states.values()].reverse();
  const state = runs.find((r) => r.runId === selected) || runs[0];
  if (!state)
    return (
      <button
        className="button"
        disabled
        title="提交图片建模后，可在这里查看原图和三视图"
      >
        参考与三视图
      </button>
    );
  const error = [...jobs]
    .reverse()
    .find((j) => j.visual?.runId === state.runId)?.error;
  const images = state.evidence.filter(
    (e) =>
      e.kind === "image" &&
      (filter === "all" ||
        (filter === "references"
          ? e.label.startsWith("原图") || e.label.includes("参考图")
          : filter === "textures"
            ? e.label.includes("贴图") || e.label.includes("纹理")
            : e.label.includes("检查"))),
  );
  return (
    <>
      <button className="button" onClick={() => setOpen(true)}>
        参考与三视图
      </button>
      {open &&
        createPortal(
          <section
            className="visual-reference-panel"
            role="dialog"
            aria-modal="true"
            aria-label="参考与三视图"
          >
            <header>
              <div>
                <h2>参考与三视图</h2>
                <p>生成视图是 AI 的推测，原图始终保留。</p>
              </div>
              <button
                className="button"
                onClick={() => setOpen(false)}
                autoFocus
              >
                关闭
              </button>
            </header>
            {runs.length > 1 && (
              <label>
                建模记录
                <select
                  value={state.runId}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {runs.map((r, i) => (
                    <option key={r.runId} value={r.runId}>
                      记录 {runs.length - i} · {r.phase}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p role="status">{state.phase}</p>
            {error && (
              <p className="visual-failure" role="alert">
                {error}
              </p>
            )}
            <label>
              查看内容
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="references">原图与三视图</option>
                <option value="renders">模型检查图</option>
                <option value="textures">材质贴图</option>
                <option value="all">所有图片</option>
              </select>
            </label>
            <div className="visual-image-grid">
              {images.map((e) => {
                const url = `/api/artifacts/${e.artifactId}`;
                return (
                  <button
                    key={e.artifactId}
                    onClick={() => setLarge({ url, label: e.label })}
                  >
                    <img src={url} alt={e.label} loading="lazy" />
                    <span>{e.label}</span>
                  </button>
                );
              })}
            </div>
            {!!state.assumptions.length && (
              <details>
                <summary>不可见结构的假设</summary>
                <ul>
                  {state.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </details>
            )}
            {!!state.reviews.length && (
              <details>
                <summary>AI 检查记录（不代表人工验收）</summary>
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
              <summary>模型与过程文件</summary>
              {state.evidence
                .filter((e) => e.kind !== "image")
                .map((e) => (
                  <p key={e.artifactId}>
                    <a href={`/api/artifacts/${e.artifactId}`} download>
                      {e.label}
                    </a>
                  </p>
                ))}
            </details>
          </section>,
          document.body,
        )}
      {large &&
        createPortal(
          <div
            className="visual-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={large.label}
            onClick={() => setLarge(null)}
          >
            <button className="button" autoFocus onClick={() => setLarge(null)}>
              关闭大图
            </button>
            <img src={large.url} alt={large.label} />
          </div>,
          document.body,
        )}
    </>
  );
}
