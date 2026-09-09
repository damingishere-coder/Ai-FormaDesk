import { Download, Image, Loader2, RotateCcw } from "lucide-react";
import type { Job, RenderSettings, Snapshot } from "./types";
import { defaultRenderSettings } from "./types";
import {
  imagePreset,
  imagePresets,
  validImageSettings,
} from "./imageComposition";
import "./image-export.css";

export function CompositionToolbar({
  disabled,
  onView,
  onReset,
}: {
  disabled: boolean;
  onView: (view: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="composition-toolbar" role="group" aria-label="取景视角">
      {[
        ["front", "正面"],
        ["side", "侧面"],
        ["top", "顶部"],
      ].map(([value, label]) => (
        <button key={value} disabled={disabled} onClick={() => onView(value)}>
          {label}
        </button>
      ))}
      <button disabled={disabled} onClick={onReset}>
        <RotateCcw size={14} />
        重置进入时视角
      </button>
    </div>
  );
}

export function ImageExport({
  snapshot,
  settings,
  onSettings,
  busy,
  ready,
  job,
  error,
  stale,
  onRender,
  onViewImage,
  onReload,
}: {
  snapshot: Snapshot;
  settings: RenderSettings;
  onSettings: (settings: RenderSettings) => void;
  busy: boolean;
  ready: "loading" | "ready" | "failed";
  job: Job | null;
  error: string;
  stale: boolean;
  onRender: () => void;
  onViewImage: () => void;
  onReload: () => void;
}) {
  const valid = validImageSettings(settings);
  const previous = snapshot.render?.settings || defaultRenderSettings;
  return (
    <>
      <div className="image-export-fields">
        <h2>画面设置</h2>
        <p className="composition-description">
          实时构图预览，最终材质和光照以成品图为准。
        </p>
        <fieldset disabled={busy}>
          <label className="render-field">
            画面比例
            <select
              aria-label="画面比例"
              value={imagePreset(settings)}
              onChange={(event) => {
                const preset =
                  imagePresets[event.target.value as keyof typeof imagePresets];
                // Custom selects the editable dimensions without changing the current framing.
                if (preset) onSettings({ ...settings, ...preset });
                else document.getElementById("composition-width")?.focus();
              }}
            >
              <option value="landscape">横版 · 16:9</option>
              <option value="square">方形 · 1:1</option>
              <option value="portrait">竖版 · 9:16</option>
              <option value="custom">自定义尺寸</option>
            </select>
          </label>
          <div className="render-dimensions">
            <label>
              宽度
              <input
                id="composition-width"
                aria-label="图片宽度"
                type="number"
                min={256}
                max={4096}
                value={settings.width || ""}
                onChange={(event) =>
                  onSettings({
                    ...settings,
                    width: Number(event.target.value),
                  })
                }
              />
            </label>
            <span>×</span>
            <label>
              高度
              <input
                aria-label="图片高度"
                type="number"
                min={256}
                max={4096}
                value={settings.height || ""}
                onChange={(event) =>
                  onSettings({
                    ...settings,
                    height: Number(event.target.value),
                  })
                }
              />
            </label>
            <span>px</span>
          </div>
          <label className="composition-transparent">
            <input
              type="checkbox"
              checked={settings.transparent}
              onChange={(event) =>
                onSettings({ ...settings, transparent: event.target.checked })
              }
            />
            透明背景 <small>PNG</small>
          </label>
        </fieldset>
        {!valid && (
          <p className="danger-text" role="alert">
            宽高均需为 256～4096 的整数。
          </p>
        )}
        {ready !== "ready" && (
          <div className="composition-status" role="status">
            {ready === "failed" ? (
              <>
                场景加载失败。<button onClick={onReload}>重新加载场景</button>
              </>
            ) : (
              "正在加载三维场景…"
            )}
          </div>
        )}
        {error && (
          <div className="composition-error" role="alert">
            <p>暂时无法生成图片，当前构图和设置已保留，可再次尝试。</p>
            <details>
              <summary>查看详情</summary>
              {error}
            </details>
          </div>
        )}
        {snapshot.render && (
          <section className="composition-previous" aria-label="上次成品图">
            <h3>上次成品图</h3>
            <button
              className="composition-thumbnail"
              onClick={onViewImage}
              aria-label="查看成品图"
            >
              <img
                src={`/api/artifacts/${snapshot.render.artifactId}`}
                alt="上次成品图缩略图"
              />
            </button>
            <p>
              {previous.width} × {previous.height} ·{" "}
              {previous.transparent ? "透明背景" : "不透明背景"}
            </p>
            {stale && <small>构图或设置已变化，可重新生成。</small>}
            <a href={`/api/artifacts/${snapshot.render.artifactId}?download=1`}>
              <Download size={15} />
              下载原图
            </a>
          </section>
        )}
      </div>
      <div className="composition-submit">
        {busy && (
          <p role="status">
            {job?.type === "render"
              ? job.stage || "正在生成图片…"
              : "请等待当前任务完成…"}
          </p>
        )}
        <button
          className="button dark"
          disabled={!valid || busy || ready !== "ready" || !snapshot.revision}
          onClick={onRender}
        >
          {busy ? <Loader2 size={17} className="spin" /> : <Image size={17} />}
          {busy ? "正在处理…" : "生成图片"}
        </button>
      </div>
    </>
  );
}
