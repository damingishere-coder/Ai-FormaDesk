import fs from "node:fs";
import path from "node:path";
import type { VisualJobState } from "../src/visualTypes";

/** Revision owns its references; job cleanup must not break saved works. */
export function archiveVisual(
  state: VisualJobState,
  out: string,
  resolve: (id: string) => string,
  register: (file: string, label: string, mime: string) => string,
): VisualJobState {
  const visual = structuredClone(state);
  const folder = path.join(out, "references");
  fs.mkdirSync(folder, { recursive: true });
  for (const [i, item] of visual.evidence.entries()) {
    const source = resolve(item.artifactId);
    const extension =
      item.kind === "image" ? ".png" : item.kind === "model" ? ".glb" : ".json";
    const file = path.join(folder, String(i).padStart(3, "0") + extension);
    fs.copyFileSync(source, file);
    fs.chmodSync(file, 0o400);
    if (item.kind === "image" && fs.existsSync(source + ".receipt.json")) {
      fs.copyFileSync(source + ".receipt.json", file + ".receipt.json");
      fs.chmodSync(file + ".receipt.json", 0o400);
    }
    item.artifactId = register(
      file,
      item.label,
      item.kind === "image"
        ? "image/png"
        : item.kind === "model"
          ? "model/gltf-binary"
          : "application/json",
    );
  }
  fs.writeFileSync(
    path.join(folder, "checks.json"),
    JSON.stringify(visual, null, 2),
    { mode: 0o400 },
  );
  return visual;
}
