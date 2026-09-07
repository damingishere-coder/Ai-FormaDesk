import { useEffect, useRef, useState } from "react";
import { api, uploadAttachment } from "./api";
import type { PreparedImage, Attachment } from "./types";

export function ImagePreparation({
  image,
  onClose,
  onSaved,
  onGenerate,
  generationUnavailable,
}: {
  image: PreparedImage;
  onClose: () => void;
  onSaved: (image: PreparedImage) => void;
  onGenerate: (
    image: PreparedImage,
    prompt: string,
    attachmentIds: string[],
  ) => Promise<void>;
  generationUnavailable?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mask = useRef(document.createElement("canvas"));
  const source = useRef<HTMLImageElement | null>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<"add" | "erase" | "crop">("add");
  const [brush, setBrush] = useState(35);
  const [crop, setCrop] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [prompt, setPrompt] = useState(
    "按主图还原主体，保留原有颜色、花纹和结构。",
  );
  const [auxiliary, setAuxiliary] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const url = (id: string) =>
    `/api/projects/${image.projectId}/attachments/${id}`;
  const repaint = () => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !source.current) return;
    ctx.clearRect(0, 0, image.width, image.height);
    ctx.drawImage(source.current, 0, 0);
    const overlay = document.createElement("canvas");
    overlay.width = image.width;
    overlay.height = image.height;
    const o = overlay.getContext("2d")!;
    o.drawImage(mask.current, 0, 0);
    const pixels = o.getImageData(0, 0, image.width, image.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const selected = pixels.data[i];
      pixels.data[i] = 30;
      pixels.data[i + 1] = 200;
      pixels.data[i + 2] = 140;
      pixels.data[i + 3] = selected * 0.38;
    }
    o.putImageData(pixels, 0, 0);
    ctx.drawImage(overlay, 0, 0);
  };
  useEffect(() => {
    let alive = true;
    setReady(false);
    setCrop(undefined);
    const photo = new Image(),
      matte = new Image();
    photo.src = url(image.sourceId);
    matte.src = url(image.maskId);
    void Promise.all([photo.decode(), matte.decode()])
      .then(() => {
        if (!alive) return;
        source.current = photo;
        mask.current.width = image.width;
        mask.current.height = image.height;
        mask.current.getContext("2d")!.drawImage(matte, 0, 0);
        repaint();
        setReady(true);
      })
      .catch(() => {
        if (alive) setError("图片读取失败，请重新打开");
      });
    return () => {
      alive = false;
    };
  }, [image.id]);
  async function variant(id: string) {
    const matte = new Image();
    matte.src = url(id);
    try {
      await matte.decode();
      mask.current.getContext("2d")!.drawImage(matte, 0, 0);
      repaint();
    } catch {
      setError("蒙版读取失败");
    }
  }
  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          image.width,
          ((e.clientX - rect.left) * image.width) / rect.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          image.height,
          ((e.clientY - rect.top) * image.height) / rect.height,
        ),
      ),
    };
  }
  function paint(p: { x: number; y: number }) {
    const ctx = mask.current.getContext("2d")!;
    ctx.strokeStyle = tool === "erase" ? "#000" : "#fff";
    ctx.lineWidth = brush;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(drawing.current!.x, drawing.current!.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
    drawing.current = p;
    repaint();
  }
  async function save(generate: boolean) {
    setSaving(true);
    setError("");
    try {
      const saved = await api<PreparedImage>(
        `/projects/${image.projectId}/images/${image.id}/mask`,
        { mask: mask.current.toDataURL("image/png"), crop },
      );
      onSaved(saved);
      if (generate)
        await onGenerate(
          saved,
          prompt,
          auxiliary.map((a) => a.id),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="image-preparation-backdrop">
      <section
        className="image-preparation"
        role="dialog"
        aria-modal="true"
        aria-label="准备建模主体"
      >
        <header>
          <div>
            <h2>准备建模主体</h2>
            <p>绿色区域会保留。拖动涂选，细叶和毛发可在这里修补。</p>
          </div>
          <button onClick={onClose} disabled={saving}>
            关闭
          </button>
        </header>
        {image.warning && <p role="status">{image.warning}</p>}
        <div className="image-preparation-tools">
          {image.variants.length > 1 &&
            image.variants.map((v, i) => (
              <button key={v.maskId} onClick={() => void variant(v.maskId)}>
                主体 {i + 1}
              </button>
            ))}
          {(
            [
              ["add", "保留"],
              ["erase", "去除"],
              ["crop", "裁切"],
            ] as const
          ).map(([key, title]) => (
            <button
              key={key}
              aria-pressed={tool === key}
              onClick={() => setTool(key)}
            >
              {title}
            </button>
          ))}
          <label>
            画笔{" "}
            <input
              aria-label="蒙版画笔大小"
              type="range"
              min="3"
              max="160"
              value={brush}
              onChange={(e) => setBrush(Number(e.target.value))}
            />
          </label>
          {crop && (
            <button
              onClick={() => {
                setCrop(undefined);
                repaint();
              }}
            >
              取消裁切
            </button>
          )}
        </div>
        <canvas
          ref={canvas}
          width={image.width}
          height={image.height}
          aria-label="主体蒙版画布"
          onPointerDown={(e) => {
            if (!ready || saving) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = point(e);
            if (tool !== "crop") paint(drawing.current);
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const p = point(e);
            if (tool !== "crop") paint(p);
            else {
              const start = drawing.current;
              const region = {
                left: Math.floor(Math.min(start.x, p.x)),
                top: Math.floor(Math.min(start.y, p.y)),
                width: Math.floor(Math.abs(start.x - p.x)),
                height: Math.floor(Math.abs(start.y - p.y)),
              };
              setCrop(region);
              repaint();
              const c = canvas.current!.getContext("2d")!;
              c.strokeStyle = "white";
              c.lineWidth = 3;
              c.strokeRect(
                region.left,
                region.top,
                region.width,
                region.height,
              );
            }
          }}
          onPointerUp={() => {
            drawing.current = null;
          }}
          onPointerCancel={() => {
            drawing.current = null;
          }}
        />
        <label>
          表面描述{" "}
          <input
            value={prompt}
            maxLength={2000}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          辅助参考图（可选，最多 5 张）
          <input
            type="file"
            aria-label="辅助参考图"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={saving || uploading || auxiliary.length >= 5}
            onChange={async (e) => {
              const files = Array.from(e.currentTarget.files || []);
              e.currentTarget.value = "";
              if (files.length + auxiliary.length > 5) {
                setError("辅助参考图最多 5 张");
                return;
              }
              setUploading(true);
              setError("");
              try {
                for (const file of files) {
                  const attachment = await uploadAttachment<Attachment>(
                    image.projectId,
                    file,
                  );
                  setAuxiliary((current) => [...current, attachment]);
                }
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        {auxiliary.map((a) => (
          <div key={a.id} className="auxiliary-reference">
            <img src={url(a.id)} alt={a.name} width="48" height="48" />
            <span>{a.name}</span>
            <button
              disabled={saving || uploading}
              onClick={() =>
                setAuxiliary((current) => current.filter((v) => v.id !== a.id))
              }
            >
              移除
            </button>
          </div>
        ))}
        <p>
          当前主体图为主图。辅助图帮助核对结构和颜色描述，不直接参与多视图形体重建。
        </p>
        <p>
          图生建模仍为实验性。优先保留原图可见区域，再补齐侧背面；未通过对照检查的结果会保留为候选。
        </p>
        {error && <p role="alert">{error}</p>}
        {generationUnavailable && <p role="status">{generationUnavailable}</p>}
        <footer>
          <button
            disabled={!ready || saving || uploading}
            onClick={() => void save(false)}
          >
            保存主体
          </button>
          <button
            className="button dark"
            disabled={
              !ready ||
              saving ||
              uploading ||
              !prompt.trim() ||
              !!generationUnavailable
            }
            onClick={() => void save(true)}
          >
            {saving ? "正在处理…" : "生成形体与表面候选"}
          </button>
        </footer>
      </section>
    </div>
  );
}
