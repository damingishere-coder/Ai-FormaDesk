import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DATA } from "./config";
import { db, get, project, put, revision, uid } from "./store";

const COVER_STYLE_VERSION = 3;
type Cover = { id: string; projectId: string; artifactId: string; styleVersion?: number };
type ImageArtifact = {
  id: string;
  projectId: string;
  path: string;
  mime: string;
  name: string;
};

export function savedCover(projectId: string, revisionId: string | null) {
  if (!revisionId) return null;
  const cover = get<Cover>("cover", revisionId);
  const image = cover && get<ImageArtifact>("artifact", cover.artifactId);
  return cover?.projectId === projectId &&
    cover.styleVersion === COVER_STYLE_VERSION &&
    image?.projectId === projectId &&
    fs.existsSync(image.path)
    ? `/api/artifacts/${image.id}`
    : null;
}

export async function saveCover(
  projectId: string,
  revisionId: string,
  image: string,
  replace = false,
) {
  function assertOwner() {
    project(projectId);
    if (replace && project(projectId).currentRevisionId !== revisionId)
      throw Object.assign(new Error("作品版本已变化，请重新刷新封面"), {
        statusCode: 409,
      });
    if (revision(revisionId).projectId !== projectId)
      throw Object.assign(new Error("封面版本不属于此作品"), {
        statusCode: 404,
      });
  }
  assertOwner();
  const existing = savedCover(projectId, revisionId);
  if (existing && !replace) return { coverUrl: existing };
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(
    image,
  );
  if (!match)
    throw Object.assign(new Error("封面图片格式无效"), { statusCode: 400 });
  const bytes = await sharp(Buffer.from(match[1], "base64"), {
    limitInputPixels: 4_000_000,
  })
    .resize(640, 400, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#f4f5f1" })
    .jpeg({ quality: 85 })
    .toBuffer();
  // Decoding yields: recheck ownership/deletion and concurrent uploads before writing.
  assertOwner();
  const concurrent = savedCover(projectId, revisionId);
  if (concurrent && (!replace || concurrent !== existing))
    return { coverUrl: concurrent };
  const id = uid(),
    dir = path.join(DATA, "covers", projectId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jpg`);
  fs.writeFileSync(file, bytes, { flag: "wx" });
  try {
    db.transaction(() => {
      put("artifact", {
        id,
        projectId,
        path: file,
        mime: "image/jpeg",
        name: "作品封面.jpg",
      });
      put("cover", { id: revisionId, projectId, artifactId: id, styleVersion: COVER_STYLE_VERSION });
    })();
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  }
  return { coverUrl: `/api/artifacts/${id}` };
}
