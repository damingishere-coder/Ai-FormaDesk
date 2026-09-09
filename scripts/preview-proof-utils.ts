import assert from "node:assert/strict";

export function objectMaterials(glb: Buffer, objectId: string) {
  const doc = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
  const node = doc.nodes.find((n: any) => n.extras?.forma_id === objectId);
  assert.ok(node && node.mesh !== undefined, "预览必须保留目标对象和网格");
  return { doc, materials: doc.meshes[node.mesh].primitives.map((p: any) => doc.materials[p.material]) };
}

export function objectColorMaps(glb: Buffer, objectId: string): Buffer[] {
  const { doc, materials } = objectMaterials(glb, objectId);
  const sources = new Set<number>();
  for (const mat of materials) {
    const index = mat.pbrMetallicRoughness?.baseColorTexture?.index;
    if (index === undefined) continue;
    const texture = doc.textures[index];
    sources.add(texture.extensions?.EXT_texture_webp?.source ?? texture.source);
  }
  return [...sources].map(source => {
    const view = doc.bufferViews[doc.images[source].bufferView];
    const start = 28 + glb.readUInt32LE(12) + (view.byteOffset || 0);
    return glb.subarray(start, start + view.byteLength);
  });
}
