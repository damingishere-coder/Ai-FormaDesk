import { useState, type ReactNode } from "react";
import { ArrowLeft, Box, Download, Image, Video } from "lucide-react";
import type { Snapshot } from "./types";

export type ExportTab = "image" | "model" | "video";

export function ExportPanel({
  snapshot,
  tab,
  onTab,
  onClose,
  locked,
  children,
}: {
  snapshot: Snapshot;
  tab: ExportTab;
  onTab: (tab: ExportTab) => void;
  onClose: () => void;
  locked: boolean;
  children: ReactNode;
}) {
  const [format, setFormat] = useState<"blend" | "glb">("glb");
  const tabs = [
    { id: "image", label: "图片", icon: Image },
    { id: "model", label: "模型", icon: Box },
    { id: "video", label: "视频", icon: Video },
  ] as const;
  return (
    <>
      <header className="image-export-header">
        <button onClick={onClose} disabled={locked}
          title={locked ? "请先保存或结束录制，再返回工作台切换作品。" : undefined}
          autoFocus>
          <ArrowLeft size={18} />
          返回工作台
        </button>
        <h1>导出作品</h1>
        <span>{snapshot.project.name}</span>
      </header>
      <aside className="image-export-settings" aria-label="导出设置">
        <div className="export-type-tabs" role="tablist" aria-label="导出类型">
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              id={`export-tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              aria-controls="export-content"
              tabIndex={tab === id ? 0 : -1}
              disabled={locked}
              onClick={() => onTab(id)}
              onKeyDown={(e) => {
                const next =
                  e.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : e.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? tabs.length - 1
                          : null;
                if (next === null) return;
                e.preventDefault();
                onTab(tabs[next].id);
                document.getElementById(`export-tab-${tabs[next].id}`)?.focus();
              }}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
        <div
          id="export-content"
          className="export-content"
          role="tabpanel"
          aria-labelledby={`export-tab-${tab}`}
        >
          {tab === "model" ? (
            <>
              <div className="image-export-fields">
                <h2>模型文件</h2>
                <p className="composition-description">
                  下载当前已保存的完整场景。左侧视角仅用于预览，不会裁切模型。
                </p>
                <fieldset className="model-formats">
                  <legend>文件格式</legend>
                  {(
                    [
                      ["glb", "通用三维模型", "用于网页展示和其他 3D 工具"],
                      ["blend", "Blender 源文件", "保留完整场景，可继续编辑"],
                    ] as const
                  ).map(([value, label, description]) => (
                    <label
                      key={value}
                      className={format === value ? "selected" : ""}
                    >
                      <input
                        type="radio"
                        name="model-format"
                        checked={format === value}
                        onChange={() => setFormat(value)}
                      />
                      <span>
                        <strong>
                          {label}
                          <small>.{value}</small>
                        </strong>
                        <span>{description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <dl className="model-export-summary">
                  <div>
                    <dt>场景对象</dt>
                    <dd>{snapshot.scene.stats.objects.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>三角面</dt>
                    <dd>{snapshot.scene.stats.triangles.toLocaleString()}</dd>
                  </div>
                </dl>
              </div>
              <div className="composition-submit">
                {snapshot.revision ? (
                  <a
                    className="button dark"
                    href={`/api/artifacts/${snapshot.revision.artifacts[format]}?download=1`}
                  >
                    <Download size={17} />
                    下载模型 · .{format}
                  </a>
                ) : (
                  <button className="button dark" disabled>
                    暂无可下载的模型
                  </button>
                )}
              </div>
            </>
          ) : (
            children
          )}
        </div>
      </aside>
    </>
  );
}
