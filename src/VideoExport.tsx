import { useState } from "react";
import type { Snapshot, VideoSettings, Job } from "./types";
import { api } from "./api";
export function VideoExport({
  snapshot,
  busy,
  onRecord,
  onJob,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onRecord: (s: VideoSettings) => void;
  onJob: (j: Job) => void;
}) {
  const [settings, setSettings] = useState<VideoSettings>({
      width: 1280,
      height: 720,
      fps: 30,
      mode: "realtime",
    }),
    [error, setError] = useState("");
  const valid = [settings.width, settings.height].every(
    (n) => Number.isInteger(n) && n >= 256 && n <= 1920 && n % 2 === 0,
  );
  const active =
    snapshot.activeJob?.type === "video" ? snapshot.activeJob : null;
  return (
    <div className="video-export">
      <p className="muted">录下你旋转、平移和缩放模型的过程。</p>
      <div className="video-modes">
        {(["realtime", "blender"] as const).map((mode) => (
          <button
            key={mode}
            className={settings.mode === mode ? "active" : ""}
            onClick={() => setSettings({ ...settings, mode })}
          >
            <strong>
              {mode === "realtime" ? "实时录制" : "Blender 精细渲染"}
            </strong>
            <small>
              {mode === "realtime"
                ? "所见即所得，停止即可下载"
                : "记录镜头后逐帧渲染"}
            </small>
          </button>
        ))}
      </div>
      <label className="render-field">
        画面比例
        <select
          aria-label="视频比例"
          onChange={(e) => {
            const [width, height] = e.target.value.split("x").map(Number);
            if (width) setSettings({ ...settings, width, height });
          }}
          defaultValue="1280x720"
        >
          <option value="1280x720">横版 16:9</option>
          <option value="1024x1024">方形 1:1</option>
          <option value="720x1280">竖版 9:16</option>
          <option value="">自定义</option>
        </select>
      </label>
      <div className="render-dimensions">
        {(["width", "height"] as const).map((key) => (
          <label key={key}>
            {key === "width" ? "宽度" : "高度"}
            <input
              aria-label={key === "width" ? "视频宽度" : "视频高度"}
              type="number"
              min="256"
              max="1920"
              step="2"
              value={settings[key]}
              onChange={(e) =>
                setSettings({ ...settings, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <p className="field-note">30 fps · 最长 60 秒 · 不透明背景 · 无音轨</p>
      {!valid && <p className="danger-text">宽高需为 256～1920 的偶数。</p>}
      <button
        className="button dark"
        disabled={!valid || busy || !snapshot.revision}
        onClick={() => onRecord(settings)}
      >
        进入录制模式
      </button>
      {active && (
        <div className="previous-render">
          <strong>
            {active.progress?.completed === active.progress?.total &&
            active.progress
              ? "正在编码 MP4"
              : active.stage}
          </strong>
          {active.progress && (
            <>
              <progress
                value={active.progress.completed}
                max={active.progress.total}
              />
              <small>
                {active.progress.completed} / {active.progress.total} 帧 ·
                预计剩余{" "}
                {Math.ceil((active.progress.remainingSeconds || 0) / 60)} 分钟
              </small>
            </>
          )}
          <button
            className="button"
            onClick={() =>
              void api(`/jobs/${active.id}/cancel`, {}).catch((e) =>
                setError(e.message),
              )
            }
          >
            停止渲染
          </button>
        </div>
      )}
      {[...(snapshot.videos || [])].reverse().map((v) => (
        <div className="previous-render" key={v.id}>
          <strong>
            {v.settings.mode === "blender" ? "精细视频" : "实时视频"} ·{" "}
            {v.duration.toFixed(1)} 秒
          </strong>
          <small>
            {v.settings.width} × {v.settings.height} · 版本{" "}
            {v.revisionId.slice(0, 8)}
          </small>
          {v.artifactId ? (
            <>
              <video
                controls
                preload="metadata"
                src={`/api/artifacts/${v.artifactId}`}
              />
              <a
                className="button"
                href={`/api/artifacts/${v.artifactId}?download=1`}
              >
                下载视频
              </a>
            </>
          ) : v.settings.mode === "blender" ? (
            <button
              className="button"
              disabled={
                busy || snapshot.project.currentRevisionId !== v.revisionId
              }
              onClick={() =>
                void api<Job>(
                  `/projects/${v.projectId}/videos/${v.id}/render`,
                  {},
                )
                  .then(onJob)
                  .catch((e) => setError(e.message))
              }
            >
              继续生成视频
            </button>
          ) : (
            <small>等待上传完成</small>
          )}
        </div>
      ))}
      {error && <p className="danger-text">{error}</p>}
    </div>
  );
}
