import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { visualRequest, type ImageReceipt } from "../server/visual-ai";
const dir = path.resolve("data/visual-cli-probe");
fs.mkdirSync(dir, { recursive: true });
const input = path.join(dir, "reference.png");
await sharp(
  Buffer.from(
    '<svg width="512" height="512"><rect width="512" height="512" fill="white"/><rect x="156" y="156" width="200" height="200" rx="22" fill="#398a70"/><circle cx="256" cy="256" r="45" fill="#efcb65"/></svg>',
  ),
)
  .png()
  .toFile(input);
const receipt = await visualRequest<ImageReceipt>({
  cwd: dir,
  images: [input],
  imageOutput: path.join(dir, "generated.png"),
  signal: new AbortController().signal,
  prompt:
    "必须调用原生 image_generation 工具生成真实图片。参考图是合成测试图：绿色方盒正面有一个黄色圆形图案。生成该盒子的右侧正交视图，白背景，无文字。保持绿色，侧面不添加正面的黄色圆。不要写 SVG、Python 或其他代码。不要只回复提示词。",
});
fs.writeFileSync(
  path.join(dir, "receipt.json"),
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt));
