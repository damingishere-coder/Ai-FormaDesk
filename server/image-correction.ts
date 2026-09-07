import sharp from "sharp";

export type TextureCorrection = {
  view: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  prompt: string;
};

/** Reject broad repainting; a correction must name one small screen region. */
export function correctionBounds(c: TextureCorrection) {
  if (!Number.isInteger(c.view) || c.view < 0 || c.view > 3)
    throw new Error("纠错视角无效");
  if (
    [c.left, c.top, c.right, c.bottom].some(
      (v) => !Number.isFinite(v) || v < 0 || v > 1,
    )
  )
    throw new Error("纠错选区超出图片");
  const width = c.right - c.left,
    height = c.bottom - c.top;
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > 0.35 ||
    width * height < 0.002
  )
    throw new Error("自动纠错仅支持占图片 0.2% 至 35% 的局部区域");
  if (!c.prompt.trim() || c.prompt.length > 2000)
    throw new Error("纠错描述无效");
  return {
    left: Math.floor(c.left * 512),
    top: Math.floor(c.top * 512),
    right: Math.min(512, Math.ceil(c.right * 512)),
    bottom: Math.min(512, Math.ceil(c.bottom * 512)),
  };
}

export async function correctionMask(c: TextureCorrection) {
  const b = correctionBounds(c),
    pixels = Buffer.alloc(512 * 512);
  for (let y = b.top; y < b.bottom; y++)
    pixels.fill(255, y * 512 + b.left, y * 512 + b.right);
  return sharp(pixels, { raw: { width: 512, height: 512, channels: 1 } })
    .png()
    .toBuffer();
}
