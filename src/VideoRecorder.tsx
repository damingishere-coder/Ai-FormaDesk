import { cameraAt } from "./cameraTrack";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  Square,
  Download,
  RotateCw,
} from "lucide-react";
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
import "./video-recorder.css";
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
  onReturnToWorkbench,
  onRender,
  onSaved,
  embedded = false,
}: {
  pid: string;
  base: string;
  settings: VideoSettings;
  viewport: React.RefObject<ViewportHandle | null>;
  onClose: () => void;
  onReturnToWorkbench?: () => void;
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
  const savedResult = useRef(false);
  const savingNow = useRef(false);
  const reviewPanel = useRef<HTMLDivElement>(null);
  const showReview = state === "review" && !playing;
  useEffect(() => {
    if (!showReview) return;
    const editor = document.querySelector<HTMLElement>(".editor-shell");
    const previousInert = editor?.inert;
    if (editor) editor.inert = true;
    reviewPanel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (editor) editor.inert = previousInert || false;
    };
  }, [showReview]);
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
        else if (playing) stopPlayback();
        else if (state !== "finishing" && !saving) void leave("export");
      }
      if (e.key === "Tab" && showReview) {
        const controls = [
          ...(reviewPanel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href],video",
          ) || []),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (
          first &&
          last &&
          (!reviewPanel.current?.contains(document.activeElement) ||
            (e.shiftKey
              ? document.activeElement === first
              : document.activeElement === last))
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [state, saving, playing]);
  async function start() {
    setError("");
    setSaved(false);
    savedResult.current = false;
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
  function stopPlayback() {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  }
  async function ensureRecord() {
    if (!record.current)
      record.current = await api<VideoRecord>(`/projects/${pid}/videos`, {
        baseRevisionId: base,
        settings,
        samples: samples.current,
      });
    return record.current;
  }
  async function persistResult() {
    if (savedResult.current) return;
    const value = await ensureRecord();
    if (settings.mode === "realtime") {
      if (!blob.current) throw new Error("视频尚未就绪");
      await uploadVideoFile(pid, value.id, blob.current);
    }
    savedResult.current = true;
    setSaved(true);
    onSaved();
  }
  async function preserveAndContinue(next: () => void) {
    if (savingNow.current || state === "finishing") return;
    savingNow.current = true;
    setSaving(true);
    setError("");
    try {
      if (state === "review") await persistResult();
      next();
    } catch (e) {
      setError(
        `保存未完成，录制结果仍保留在这里。${(e as Error).message}，可重试返回或先下载视频。`,
      );
    } finally {
      savingNow.current = false;
      setSaving(false);
    }
  }
  async function leave(destination: "export" | "workbench") {
    if (state === "recording") {
      stop();
      return;
    }
    await preserveAndContinue(() => {
      stopPlayback();
      if (destination === "workbench" && onReturnToWorkbench)
        onReturnToWorkbench();
      else onClose();
    });
  }
  async function save() {
    if (savingNow.current) return;
    savingNow.current = true;
    setSaving(true);
    setError("");
    try {
      await persistResult();
      if (settings.mode === "blender" && (await onRender(record.current!.id)))
        onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      savingNow.current = false;
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
      {!showReview && (
        <div
          className="recording-bar glass"
          role="region"
          aria-label="视频录制"
        >
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
              state === "recording"
                ? "recording-clock active"
                : "recording-clock"
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
          {playing && (
            <button className="button" onClick={stopPlayback}>
              <ArrowLeft size={16} />
              返回录制结果
            </button>
          )}
          <button
            className="button recording-back"
            aria-label={
              state === "recording" ? "停止并查看结果" : "返回导出设置"
            }
            disabled={state === "finishing" || saving}
            onClick={() => {
              if (state === "recording") stop();
              else void leave("export");
            }}
          >
            <ArrowLeft size={16} />
            {state === "recording" ? "停止并查看结果" : "返回导出设置"}
          </button>
        </div>
      )}
      {showReview && (
        <div className="video-review-backdrop">
          <div
            ref={reviewPanel}
            className="video-review glass"
            role="dialog"
            aria-modal="true"
            aria-label="录制结果"
            aria-describedby="video-review-save-hint"
          >
            <header className="video-review-header">
              <div className="video-review-navigation">
                <button
                  className="button"
                  disabled={saving}
                  onClick={() => void leave("export")}
                >
                  <ArrowLeft size={16} />
                  返回导出设置
                </button>
                <button
                  className="button"
                  disabled={saving}
                  onClick={() => void leave("workbench")}
                >
                  返回作品工作台
                </button>
              </div>
              <div className="video-review-title">
                <div>
                  <span>导出作品 / 视频录制</span>
                  <h2>录制结果</h2>
                </div>
                <span>
                  {elapsedText(duration)} · {settings.width} × {settings.height}
                </span>
              </div>
            </header>
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
                onClick={() =>
                  void preserveAndContinue(() => {
                    void start();
                  })
                }
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
                disabled={saving || (saved && settings.mode === "realtime")}
                onClick={() => void save()}
              >
                {saving
                  ? "正在保存…"
                  : settings.mode === "blender"
                    ? "生成精细视频"
                    : saved
                      ? "已保存到作品"
                      : "保存到作品"}
              </button>
            </div>
            <p
              id="video-review-save-hint"
              className="video-review-save-hint"
              role="status"
            >
              <Check size={14} />
              {saving
                ? "正在保存，请稍候…"
                : saved
                  ? settings.mode === "realtime"
                    ? "视频已保存到作品，可以放心返回。"
                    : "镜头路线已保存，可以返回后继续渲染。"
                  : settings.mode === "realtime"
                    ? "返回或重新录制前，会先将本次视频保存到作品。"
                    : "返回或重新录制前，会先保存本次镜头路线。"}
            </p>
            {error && (
              <p className="video-review-error" role="alert">
                {error}
              </p>
            )}
            {settings.mode === "blender" && (
              <p>
                按本次镜头逐帧渲染，耗时取决于模型复杂度。可在任务中查看帧数进度、取消或重试。
              </p>
            )}
          </div>
        </div>
      )}
      {error && !showReview && (
        <div className="recording-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
