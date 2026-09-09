import fs from "node:fs/promises";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";

/** Only preview textures change; hierarchy, geometry, extras and material slots stay intact. */
export async function optimizePreview(input: string, output: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(input);
  const nodesBefore = document.getRoot().listNodes().map(n => ({
    name: n.getName(), extras: n.getExtras(), matrix: n.getMatrix(),
    children: n.listChildren().map(c => c.getName()),
  }));
  await document.transform(
    dedup({ propertyTypes: [PropertyType.TEXTURE] }),
    textureCompress({ encoder: sharp, targetFormat: "webp", lossless: true, effort: 0 }),
  );
  signal.throwIfAborted();
  const nodesAfter = document.getRoot().listNodes().map(n => ({
    name: n.getName(), extras: n.getExtras(), matrix: n.getMatrix(),
    children: n.listChildren().map(c => c.getName()),
  }));
  if (JSON.stringify(nodesBefore) !== JSON.stringify(nodesAfter)) throw new Error("预览压缩改变了对象结构");
  await io.write(output, document);
  signal.throwIfAborted();
  const before = (await fs.stat(input)).size, after = (await fs.stat(output)).size;
  if (after >= before) {
    await fs.copyFile(input, output);
    return { before, after: before, compressed: false };
  }
  return { before, after, compressed: true };
}
