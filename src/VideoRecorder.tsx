import { cameraAt } from "./cameraTrack";
import { useEffect, useRef, useState } from "react";
import { Circle, Square, X, Download, RotateCw } from "lucide-react";
import { api, uploadVideoFile } from "./api";
import type { ViewportHandle } from "./Viewport";
import type {
  CameraSpec,
  Trajectory,
  VideoRecord,
  VideoSettings,
} from "./types";
import { elapsedText } from "./progress";
import { videoFrameClock } from "./videoTiming";
export function supportedVideoMime() {
  return typeof MediaRecorder === "undefined"
    ? ""
    : [
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ].find((v) => MediaRecorder.isTypeSupported(v)) || "";
}
export function VideoRecorder({
  pid,
  base,
  settings,
  viewport,
  onClose,
  onRender,
  onSaved,
  embedded = false,
}: {
  pid: string;
  base: string;
  settings: VideoSettings;
  viewport: React.RefObject<ViewportHandle | null>;
  onClose: () => void;
  onRender: (id: string) => Promise<boolean>;
  onSaved: () => void;
  embedded?: boolean;
}) {
  const [state, setState] = useState<
      "ready" | "recording" | "finishing" | "review"
    >("ready"),
    [duration, setDuration] = useState(0),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const [playing, setPlaying] = useState(false);
  const mime = supportedVideoMime(),
    recorder = useRef<MediaRecorder | null>(null),
    raf = useRef(0),
    startTime = useRef(0),
    samples = useRef<Trajectory["samples"]>([]),
    blob = useRef<Blob | null>(null),
    record = useRef<VideoRecord | null>(null),
    original = useRef<CameraSpec | null>(null),
    canvas = useRef<HTMLCanvasElement | null>(null),
    stopping = useRef(false);
  const outputUrl = useRef("");
  useEffect(() => {
    original.current = viewport.current?.sampleCamera() || null;
    return () => {
      cancelAnimationFrame(raf.current);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (recorder.current?.state === "recording") recorder.current.stop();
      if (outputUrl.current) URL.revokeObjectURL(outputUrl.current);
      if (original.current) viewport.current?.restoreCamera(original.current);
    };
  }, []);
  function sample(time: number) {
    const c = viewport.current?.sampleCamera();
    if (c) {
      c.fov = 42;
      c.aspect = settings.width / settings.height;
      const t = Math.min(60, time);
      if (!samples.current.length || t > samples.current.at(-1)!.time)
        samples.current.push({ time: t, camera: c });
    }
  }
  function stop() {
    if (stopping.current) return;
    stopping.current = true;
    cancelAnimationFrame(raf.current);
    sample(Math.max(0.1, (performance.now() - startTime.current) / 1000));
    setState("finishing");
    if (recorder.current?.state === "recording") recorder.current.stop();
    else setState("review");
  }
  useEffect(() => {
    const visibility = () => {
      if (document.hidden && state === "recording") stop();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (state === "recording") stop();
        else if (state !== "finishing" && !saving) onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [state, saving]);
  async function start() {
    setError("");
    setSaved(false);
    record.current = null;
    stopping.current = false;
    samples.current = [];
    blob.current = null;
    if (outputUrl.current) URL.revokeObjectURL(outputUrl.current);
    setUrl("");
    setDuration(0);
    try {
      const target = document.createElement("canvas");
      target.width = settings.width;
      target.height = settings.height;
      canvas.current = target;
      viewport.current?.drawVideo(target);
      if (mime) {
        const stream = target.captureStream(settings.fps);
        const r = new MediaRecorder(stream, {
          mimeType: mime,
          videoBitsPerSecond: settings.fps === 60 ? 16_000_000 : 8_000_000,
        });
        recorder.current = r;
        const chunks: BlobPart[] = [];
        let size = 0;
        r.ondataavailable = (e) => {
          if (e.data.size) {
            chunks.push(e.data);
            size += e.data.size;
            if (size >= 120 * 1024 * 1024) {
              setError("视频达到大小限制，已停止录制");
              stop();
            }
          }
        };
        r.onstop = () => {
          const result = new Blob(chunks, { type: r.mimeType });
          blob.current = result;
          outputUrl.current = URL.createObjectURL(result);
          setUrl(outputUrl.current);
          stream.getTracks().forEach((t) => t.stop());
          setState("review");
        };
        r.onerror = () => {
          setError("录制发生错误，已保留镜头路线");
          stop();
        };
        r.start(500);
      } else if (settings.mode === "realtime")
        throw new Error(
          "当前浏览器不支持视频编码，请使用 Chrome 或选择 Blender 精细渲染",
        );
      startTime.current = performance.now();
      sample(0);
      setState("recording");
      const frameDue = videoFrameClock(settings.fps);
      let displayedSecond = 0;
      const tick = () => {
        const elapsed = (performance.now() - startTime.current) / 1000;
        if (frameDue(elapsed)) {
          viewport.current?.drawVideo(target);
          sample(elapsed);
        }
        if (Math.floor(elapsed) !== displayedSecond) {
          displayedSecond = Math.floor(elapsed);
          setDuration(Math.min(60, elapsed));
        }
        if (elapsed >= 60) {
          stop();
          return;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (e) {
      setError((e as Error).message);
      setState("ready");
    }
  }
  function playRoute() {
    cancelAnimationFrame(raf.current);
    setPlaying(true);
    const begin = performance.now();
    const tick = () => {
      const time = (performance.now() - begin) / 1000;
      viewport.current?.restoreCamera(cameraAt(samples.current, time));
      if (time >= samples.current.at(-1)!.time) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      if (!record.current)
        record.current = await api<VideoRecord>(`/projects/${pid}/videos`, {
          baseRevisionId: base,
          settings,
          samples: samples.current,
        });
      if (settings.mode === "realtime") {
        if (!blob.current) throw new Error("视频尚未就绪");
        await uploadVideoFile(pid, record.current!.id, blob.current);
        setSaved(true);
        onSaved();
      } else if (await onRender(record.current!.id)) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const extension = mime.includes("mp4") ? "mp4" : "webm";
  return (
    <div className="video-recorder">
      {!embedded && (
        <div
          className="recording-frame"
          style={{
            width: `min(100vw, calc(100vh * ${settings.width / settings.height}))`,
            height: `min(100vh, calc(100vw / ${settings.width / settings.height}))`,
          }}
        />
      )}
      <div className="recording-bar glass" role="region" aria-label="视频录制">
        <div>
          <strong>
            {settings.mode === "realtime" ? "实时录制" : "Blender 镜头录制"}
          </strong>
          <small>
            {settings.width} × {settings.height} · {settings.fps} fps ·{" "}
            {settings.mode === "realtime"
              ? extension.toUpperCase()
              : "H.264 MP4"}{" "}
            · 最长 60 秒
          </small>
        </div>
        <span
          className={
            state === "recording" ? "recording-clock active" : "recording-clock"
          }
        >
          {elapsedText(duration)}
        </span>
        {state === "ready" && (
          <button className="button dark" onClick={() => void start()}>
            <Circle size={16} />
            开始录制
          </button>
        )}
        {state === "recording" && (
          <button className="button dark" onClick={stop}>
            <Square size={16} />
            停止录制
          </button>
        )}
        {state === "finishing" && <span>正在整理视频…</span>}
        <button
          className="icon"
          aria-label="退出录制模式"
          disabled={state === "finishing" || saving}
          onClick={() => {
            if (state === "recording") stop();
            else onClose();
          }}
        >
          <X size={18} />
        </button>
      </div>
      {state === "review" && !playing && (
        <div className="video-review glass" role="dialog" aria-label="录制结果">
          {url ? (
            <video src={url} controls playsInline />
          ) : (
            <p>镜头路线已记录，可交给 Blender 渲染。</p>
          )}
          <div className="video-review-actions">
            <button className="button" disabled={saving} onClick={playRoute}>
              播放镜头路线
            </button>
            <button
              className="button"
              disabled={saving}
              onClick={() => void start()}
            >
              <RotateCw size={15} />
              重新录制
            </button>
            {url && (
              <a
                className="button"
                href={url}
                download={`FormaDesk-${base}.${extension}`}
              >
                <Download size={15} />
                下载{settings.mode === "blender" ? "预览" : ""}视频
              </a>
            )}
            <button
              className="button dark"
              disabled={saving || saved}
              onClick={() => void save()}
            >
              {saving
                ? "正在保存…"
                : saved
                  ? "已保存到作品"
                  : settings.mode === "blender"
                    ? "生成精细视频"
                    : "保存到作品"}
            </button>
          </div>
          {settings.mode === "blender" && (
            <p>
              按本次镜头逐帧渲染，耗时取决于模型复杂度。可在任务中查看帧数进度、取消或重试。
            </p>
          )}
        </div>
      )}
      {error && (
        <div className="recording-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
