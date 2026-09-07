import { useState } from "react";
import { Box, Download, Image, X } from "lucide-react";
import type { RenderSettings, Snapshot } from "./types";
import { defaultRenderSettings } from "./types";
export function ExportPanel({
  snapshot,
  settings,
  onSettings,
  busy,
  stale,
  initial,
  onRender,
  onViewImage,
  onClose,
}: {
  snapshot: Snapshot;
  settings: RenderSettings;
  onSettings: (v: RenderSettings) => void;
  busy: boolean;
  stale: boolean;
  initial: "model" | "image";
  onRender: () => void;
  onViewImage: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initial),
    [preset, setPreset] = useState("custom");
  const render = snapshot.render,
    previous = render?.settings || defaultRenderSettings;
  const valid = [settings.width, settings.height].every(
    (n) => Number.isInteger(n) && n >= 256 && n <= 4096,
  );
  return (
    <div className="modal-backdrop export-backdrop" onClick={onClose}>
      <section
        className="modal glass export-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导出作品"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>带走你的作品</h2>
          <button className="icon" aria-label="关闭导出" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="export-tabs">
          <button
            className={tab === "model" ? "active" : ""}
            onClick={() => setTab("model")}
          >
            <Box size={16} />
            模型文件
          </button>
          <button
            className={tab === "image" ? "active" : ""}
            onClick={() => setTab("image")}
          >
            <Image size={16} />
            效果图
          </button>
        </div>
        {tab === "model" ? (
          <>
            <p className="muted">包含当前已保存场景及全部网页修改。</p>
            <div className="export-options">
              {snapshot.revision &&
                [
                  ["blend", "Blender 源文件", "完整场景，可继续编辑"],
                  ["glb", "通用三维模型", "用于网页与其他 3D 工具"],
                ].map(([key, name, desc]) => (
                  <a
                    key={key}
                    href={`/api/artifacts/${snapshot.revision!.artifacts[key as "blend"]}?download=1`}
                  >
                    <Box size={24} />
                    <span>
                      <strong>{name}</strong>
                      <small>
                        .{key} · {desc}
                      </small>
                    </span>
                    <Download size={17} />
                  </a>
                ))}
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              使用当前视角出图。关闭面板后可继续调整构图。
            </p>
            <label className="render-field">
              画面比例
              <select
                aria-label="画面比例"
                value={preset}
                onChange={(e) => {
                  const v = e.target.value;
                  setPreset(v);
                  const sizes: Record<string, [number, number]> = {
                    landscape: [1280, 720],
                    square: [1024, 1024],
                    portrait: [720, 1280],
                  };
                  if (sizes[v])
                    onSettings({
                      ...settings,
                      width: sizes[v][0],
                      height: sizes[v][1],
                    });
                }}
              >
                <option value="landscape">横版 · 16:9</option>
                <option value="square">方形 · 1:1</option>
                <option value="portrait">竖版 · 9:16</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <div className="render-dimensions">
              <label>
                宽度
                <input
                  aria-label="图片宽度"
                  type="number"
                  min={256}
                  max={4096}
                  value={settings.width || ""}
                  onChange={(e) => {
                    setPreset("custom");
                    onSettings({ ...settings, width: Number(e.target.value) });
                  }}
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
                  onChange={(e) => {
                    setPreset("custom");
                    onSettings({ ...settings, height: Number(e.target.value) });
                  }}
                />
              </label>
              <span>px</span>
            </div>
            <label className="transparent-field">
              <input
                type="checkbox"
                checked={settings.transparent}
                onChange={(e) =>
                  onSettings({ ...settings, transparent: e.target.checked })
                }
              />
              透明背景<span>PNG · 保留透明通道</span>
            </label>
            {!valid && (
              <p className="danger-text">宽高均需为 256～4096 的整数。</p>
            )}
            <button
              className="button dark render-submit"
              disabled={!valid || busy || !snapshot.revision}
              onClick={onRender}
            >
              <Image size={17} />
              {busy ? "正在处理…" : "按当前视角渲染"}
            </button>
            {render && (
              <div className="previous-render">
                <strong>
                  {stale
                    ? "需要重新渲染 · 场景、视角或设置已变化"
                    : "当前成品图"}
                </strong>
                <small>
                  {previous.width} × {previous.height} ·{" "}
                  {previous.transparent ? "透明背景" : "不透明背景"} · 版本{" "}
                  {render.revisionId.slice(0, 8)}
                </small>
                <div>
                  <button className="button" onClick={onViewImage}>
                    查看成品图
                  </button>
                  <a
                    className="button"
                    href={`/api/artifacts/${render.artifactId}?download=1`}
                  >
                    <Download size={15} />
                    下载原图
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
