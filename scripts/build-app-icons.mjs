import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const source = "docs/brand/icon-source.png";
const { data, info } = await sharp(source)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: w, height: h } = info;
const outside = new Uint8Array(w * h),
  queue = new Int32Array(w * h);
let head = 0,
  tail = 0;
function add(i) {
  if (outside[i]) return;
  const n = i * 3;
  // Only neutral checkerboard reachable from the canvas edge is removed.
  // Ivory areas enclosed by the orange tile remain untouched.
  if (data[n] - data[n + 1] > 22 || data[n] - data[n + 2] > 35) return;
  outside[i] = 1;
  queue[tail++] = i;
}
for (let x = 0; x < w; x++) {
  add(x);
  add((h - 1) * w + x);
}
for (let y = 0; y < h; y++) {
  add(y * w);
  add(y * w + w - 1);
}
while (head < tail) {
  const i = queue[head++],
    x = i % w,
    y = Math.floor(i / w);
  if (x) add(i - 1);
  if (x + 1 < w) add(i + 1);
  if (y) add(i - w);
  if (y + 1 < h) add(i + w);
}
const rgba = Buffer.alloc(w * h * 4);
for (let i = 0; i < w * h; i++) {
  for (let c = 0; c < 3; c++) rgba[i * 4 + c] = data[i * 3 + c];
  rgba[i * 4 + 3] = outside[i] ? 0 : 255;
}
fs.mkdirSync("desktop/assets", { recursive: true });
await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
  .resize(1024, 1024)
  .png()
  .toFile("desktop/assets/icon.png");
await sharp("desktop/assets/icon.png")
  .resize(256)
  .png()
  .toFile("docs/brand/icon.png");
await sharp("desktop/assets/icon.png")
  .resize(128)
  .png()
  .toFile("public/app-icon.png");
const iconset = "build/FormaDesk.iconset";
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2])
    await sharp("desktop/assets/icon.png")
      .resize(size * scale)
      .png()
      .toFile(
        path.join(
          iconset,
          `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
        ),
      );
}
execFileSync("/usr/bin/iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  "desktop/assets/icon.icns",
]);
console.log("Selected icon C: outside alpha generated; PNG + ICNS ready.");
