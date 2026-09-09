import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  Maximize,
  Minus,
  Plus,
  Settings2,
} from "lucide-react";
import { defaultRenderSettings, type Render } from "./types";
import "./render-preview.css";

export function RenderPreview({
  render,
  stale,
  onClose,
  onSettings,
  returnLabel = "返回工作台",
}: {
  render: Render;
  stale: boolean;
  onClose: () => void;
  onSettings: () => void;
  returnLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const settings = render.settings || defaultRenderSettings;
  const [size, setSize] = useState({
    width: settings.width,
    height: settings.height,
  });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fit = Math.min(
    1,
    Math.max(1, bounds.width - 48) / size.width,
    Math.max(1, bounds.height - 48) / size.height,
  );
  const scale = zoom ?? fit;
  const canPan =
    size.width * scale > bounds.width - 48 ||
    size.height * scale > bounds.height - 48;
  const source = `/api/artifacts/${render.artifactId}`;
  const changeZoom = (factor: number) =>
    setZoom(Math.min(4, Math.max(0.1, scale * factor)));

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected)
        opener.current.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const element = canvas.current!;
    const observer = new ResizeObserver(() =>
      setBounds({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = canvas.current!;
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
  }, [scale, bounds.width, bounds.height]);

  return (
    <dialog
      ref={dialog}
      className="render-preview"
      aria-label="Blender 成品图"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="render-preview-header">
        <button
          className="render-preview-back"
          aria-label="关闭成品图"
          onClick={onClose}
          autoFocus
        >
          <ArrowLeft size={18} />
          <span>{returnLabel}</span>
        </button>
        <div className="render-preview-title">
          <h2>成品图</h2>
          <span>
            PNG · {size.width} × {size.height}
          </span>
        </div>
        <div className="render-preview-actions">
          <button onClick={onSettings}>
            <Settings2 size={17} />
            <span>导出设置</span>
          </button>
          <a className="render-preview-download" href={`${source}?download=1`}>
            <Download size={17} />
            下载原图
          </a>
        </div>
      </header>

      {stale && (
        <div className="render-preview-warning" role="status">
          需要重新渲染：场景、视角或设置已变化，当前显示的是上次成品图。
          <button onClick={onSettings}>前往重新渲染</button>
        </div>
      )}

      <div
        ref={canvas}
        className={`render-preview-canvas${canPan && status === "ready" ? " can-pan" : ""}${dragging ? " dragging" : ""}`}
        aria-label="图片预览区域"
        tabIndex={0}
        onDoubleClick={() => {
          if (status === "ready") setZoom(zoom === null ? 1 : null);
        }}
        onPointerDown={(event) => {
          if (!canPan || status !== "ready" || event.button !== 0) return;
          const element = event.currentTarget;
          element.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: element.scrollLeft,
            top: element.scrollTop,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft =
            drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop =
            drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
      >
        <div className="render-preview-sheet">
          {status === "loading" && (
            <p className="render-preview-message" role="status">
              正在加载成品图…
            </p>
          )}
          {status === "error" && (
            <div className="render-preview-message" role="alert">
              <p>图片加载失败，请重试。</p>
              <button
                onClick={() => {
                  setStatus("loading");
                  setAttempt((value) => value + 1);
                }}
              >
                重新加载
              </button>
            </div>
          )}
          <img
            key={attempt}
            src={attempt ? `${source}?retry=${attempt}` : source}
            alt="Blender 成品图"
            draggable={false}
            className={settings.transparent ? "transparent" : ""}
            style={{
              width: size.width * scale,
              height: size.height * scale,
              display: status === "ready" ? "block" : "none",
            }}
            onLoad={(event) => {
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setStatus("ready");
            }}
            onError={() => setStatus("error")}
          />
        </div>
      </div>

      <footer className="render-preview-footer">
        <span className="render-preview-info">
          {settings.transparent ? "透明背景" : "不透明背景"} · PNG
        </span>
        <div className="render-preview-zoom" role="group" aria-label="图片缩放">
          <button
            aria-label="缩小图片"
            disabled={status !== "ready" || scale <= 0.1}
            onClick={() => changeZoom(1 / 1.25)}
          >
            <Minus size={17} />
          </button>
          <output aria-label="当前缩放比例">{Math.round(scale * 100)}%</output>
          <button
            aria-label="放大图片"
            disabled={status !== "ready" || scale >= 4}
            onClick={() => changeZoom(1.25)}
          >
            <Plus size={17} />
          </button>
          <span className="render-preview-divider" />
          <button
            aria-pressed={zoom === null}
            disabled={status !== "ready"}
            onClick={() => setZoom(null)}
          >
            <Maximize size={16} />
            适应窗口
          </button>
          <button
            aria-pressed={zoom === 1}
            disabled={status !== "ready"}
            onClick={() => setZoom(1)}
          >
            原始尺寸
          </button>
        </div>
        <span className="render-preview-hint">放大后拖动查看 · Esc 返回</span>
      </footer>
    </dialog>
  );
}
