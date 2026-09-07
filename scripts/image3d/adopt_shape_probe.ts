/** Real Blender adoption of a shape-only candidate in an isolated test store. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DATA } from "../../server/config";
import { db, put, get, uid, now, project, revision } from "../../server/store";
import { enqueue, artifact } from "../../server/jobs";
import type { Job } from "../../src/types";
if (!process.env.ZAOWU_DATA_DIR || !process.argv[2])
  throw new Error(
    "Need isolated test data and validated shape probe directory",
  );
const pid = uid(),
  jid = uid();
put("project", {
  id: pid,
  name: "Shape adoption test",
  currentRevisionId: null,
  threadId: null,
  redo: [],
  createdAt: now(),
});
const dir = path.join(DATA, "jobs", jid, "attempt-0");
fs.mkdirSync(path.join(dir, "inference"), { recursive: true });
fs.copyFileSync(
  path.join(process.argv[2], "geometry-0.blend"),
  path.join(dir, "inference/geometry-0.blend"),
);
fs.copyFileSync(
  path.join(process.argv[2], "shape-candidate-0.glb"),
  path.join(dir, "shape.glb"),
);
put("job", {
  id: jid,
  projectId: pid,
  baseRevisionId: null,
  type: "image3d",
  status: "partial",
  stage: "部分完成",
  candidateCanAdopt: true,
  candidateArtifactId: artifact(
    path.join(dir, "shape.glb"),
    pid,
    "Shape.glb",
    "model/gltf-binary",
  ),
  resultRevisionId: null,
  error: "Fixture quality rejected",
  createdAt: now(),
  updatedAt: now(),
  message: "",
});
put("image3d-candidate", {
  id: jid,
  projectId: pid,
  baseRevisionId: null,
  directory: dir,
  kind: "shape",
  geometryFile: "geometry-0.blend",
  provenance: { route: "image3d", missingSteps: ["texture", "visual-quality"] },
});
assert.equal(project(pid).currentRevisionId, null);
const job = enqueue(pid, null, "accept-image3d", { candidateJobId: jid });
try {
  const deadline = Date.now() + 35 * 60 * 1000;
  let state: Job;
  do {
    await new Promise((r) => setTimeout(r, 200));
    state = get<Job>("job", job.id)!;
    if (Date.now() > deadline) throw new Error("Adoption did not complete");
  } while (["queued", "running"].includes(state.status));
  assert.equal(state.status, "succeeded", state.error || "");
  const result = revision(project(pid).currentRevisionId!);
  assert.ok(result.scene.objects.some((o) => o.type === "MESH" && o.subjectId));
  assert.deepEqual(result.image3d?.missingSteps, ["texture", "visual-quality"]);
  assert.equal(get<Job>("job", jid)?.resultRevisionId, result.id);
  assert.throws(() =>
    enqueue(pid, result.id, "accept-image3d", { candidateJobId: jid }),
  );
  const report = {
    passed: true,
    explicitAdoption: true,
    versionId: result.id,
    originalPreservedUntilAdoption: true,
    duplicateRejected: true,
    shapeOnly: true,
  };
  fs.writeFileSync(
    path.join(DATA, "adoption-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log("SHAPE_ADOPTION_OK");
} finally {
  db.close();
}
