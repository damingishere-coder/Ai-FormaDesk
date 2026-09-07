import { useEffect, useRef, useState } from "react";
import type { CameraSpec } from "./types";

type Props = {
  kind: "shape" | "surface";
  screenshot: string;
  camera: CameraSpec;
  onClose: () => void;
  onSubmit: (prompt: string, mask?: string) => Promise<boolean>;
};
export function SurfaceRefinement({
  kind,
  screenshot,
  camera,
  onClose,
  onSubmit,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    mask = useRef<HTMLCanvasElement | null>(null);
  const previous = useRef<[number, number] | null>(null);
  const [prompt, setPrompt] = useState(""),
    [brush, setBrush] = useState(32),
    [erase, setErase] = useState(false);
  const [busy, setBusy] = useState(false),
    [painted, setPainted] = useState(false);
  const [tool, setTool] = useState<"brush" | "box">("brush");
  const redraw = () => {
    const visible = canvas.current,
      source = mask.current;
    if (!visible || !source) return;
    const ctx = visible.getContext("2d")!;
    ctx.clearRect(0, 0, visible.width, visible.height);
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#53e6b0";
    ctx.fillRect(0, 0, visible.width, visible.height);
    ctx.globalCompositeOperation = "source-over";
  };
  useEffect(() => {
    if (!canvas.current) return;
    const width = camera.aspect >= 1 ? 1024 : Math.round(1024 * camera.aspect);
    const height = camera.aspect >= 1 ? Math.round(1024 / camera.aspect) : 1024;
    canvas.current.width = width;
    canvas.current.height = height;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    mask.current = c;
  }, [camera.aspect]);
  const point = (
    event: React.PointerEvent<HTMLCanvasElement>,
  ): [number, number] => {
    const c = event.currentTarget,
      box = c.getBoundingClientRect();
    return [
      ((event.clientX - box.left) * c.width) / box.width,
      ((event.clientY - box.top) * c.height) / box.height,
    ];
  };
  const paint = (
    a: [number, number],
    b: [number, number],
    rectangle = false,
  ) => {
    const ctx = mask.current!.getContext("2d")!;
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = ctx.fillStyle = "white";
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (rectangle)
      ctx.fillRect(
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.abs(a[0] - b[0]),
        Math.abs(a[1] - b[1]),
      );
    else {
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
    }
    redraw();
    setPainted(true);
  };
  const submit = async () => {
    setBusy(true);
    try {
      let png: string | undefined;
      if (kind === "surface" && mask.current) {
        // Opaque black outside the selection; transparent RGB is not a mask.
        const c = document.createElement("canvas");
        c.width = mask.current.width;
        c.height = mask.current.height;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(mask.current, 0, 0);
        png = c.toDataURL("image/png");
      }
      if (await onSubmit(prompt, png)) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="surface-refinement glass"
        role="dialog"
        aria-label={kind === "surface" ? "精修表面" : "调整形体"}
      >
        <header>
          <strong>{kind === "surface" ? "精修表面" : "调整形体"}</strong>
          <button onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        {kind === "surface" ? (
          <>
            <p>先在当前视角框选或涂选要修改的表面，再描述需要的效果。</p>
            <div className="refine-tools">
              <button
                aria-pressed={tool === "brush"}
                onClick={() => setTool("brush")}
              >
                涂选
              </button>
              <button
                aria-pressed={tool === "box"}
                onClick={() => setTool("box")}
              >
                框选
              </button>
              <button aria-pressed={erase} onClick={() => setErase((v) => !v)}>
                擦除
              </button>
              <label>
                笔刷{" "}
                <input
                  aria-label="选区笔刷大小"
                  type="range"
                  min="4"
                  max="120"
                  value={brush}
                  onChange={(e) => setBrush(+e.target.value)}
                />
              </label>
              <button
                onClick={() => {
                  mask.current?.getContext("2d")?.clearRect(0, 0, 2048, 2048);
                  redraw();
                  setPainted(false);
                }}
              >
                清空
              </button>
            </div>
            <div
              className="refine-selection"
              style={{
                aspectRatio: camera.aspect,
                width: `min(100%, ${52 * camera.aspect}vh)`,
              }}
            >
              <img src={screenshot} alt="当前模型视角" />
              <canvas
                ref={canvas}
                aria-label="表面精修选区"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  previous.current = point(e);
                  if (tool === "brush")
                    paint(previous.current, previous.current);
                }}
                onPointerMove={(e) => {
                  if (previous.current && tool === "brush") {
                    const p = point(e);
                    paint(previous.current, p);
                    previous.current = p;
                  }
                }}
                onPointerUp={(e) => {
                  if (previous.current && tool === "box")
                    paint(previous.current, point(e), true);
                  previous.current = null;
                }}
                onPointerCancel={() => {
                  previous.current = null;
                }}
              />
            </div>
          </>
        ) : (
          <p>
            描述选中对象需要调整的比例或结构。新版本会保留原版本，便于比较和撤销。
          </p>
        )}
        <textarea
          aria-label="精修要求"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            kind === "surface"
              ? "例如：减淡这里的木纹，保留原来的浅棕色"
              : "例如：把椅背略微加宽，保留四根靠背竖条"
          }
        />
        <button
          className="button dark"
          disabled={busy || !prompt.trim() || (kind === "surface" && !painted)}
          onClick={() => void submit()}
        >
          {busy ? "正在提交" : "开始精修"}
        </button>
      </section>
    </div>
  );
}
