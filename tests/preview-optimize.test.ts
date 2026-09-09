import { it, expect } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { optimizePreview } from "../server/preview-optimize";

it("无损压缩保持贴图像素与对象 ID、层级和变换", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forma-preview-compress-"));
  try {
    const original = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#839cfe" } }).png().toBuffer();
    const doc = new Document();
    doc.createBuffer();
    const texture = doc.createTexture().setImage(original).setMimeType("image/png");
    doc.createMaterial("normal").setNormalTexture(texture);
    const parent = doc.createNode("parent").setExtras({ forma_id: "parent" });
    parent.addChild(doc.createNode("part").setExtras({ forma_id: "part" }).setTranslation([1, 2, 3]));
    doc.createScene().addChild(parent);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const input = path.join(dir, "input.glb"), output = path.join(dir, "output.glb");
    await io.write(input, doc);
    await optimizePreview(input, output, new AbortController().signal);
    const result = await io.read(output);
    expect(result.getRoot().listNodes().map(n => [n.getExtras(), n.getTranslation(), n.listChildren().length])).toEqual(doc.getRoot().listNodes().map(n => [n.getExtras(), n.getTranslation(), n.listChildren().length]));
    const image = result.getRoot().listMaterials()[0].getNormalTexture()!.getImage()!;
    expect(await sharp(image).ensureAlpha().raw().toBuffer()).toEqual(await sharp(original).ensureAlpha().raw().toBuffer());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
