// Real API acceptance batch. Its status is evidence, never category approval.
import { request } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const [
  directory,
  sampleDirectory,
  port = "8891",
  filter = "all",
  privatePhoto,
] = process.argv.slice(2);
if (!directory || !sampleDirectory)
  throw new Error("Need isolated evidence and sample directory");
await fs.mkdir(directory, { recursive: true });
const context = await request.newContext({
  baseURL: `http://127.0.0.1:${port}`,
});
const { token } = await (await context.get("/api/session")).json();
const results = [];
const lock = JSON.parse(
  await fs.readFile(
    new URL("../../image3d/samples.lock.json", import.meta.url),
    "utf8",
  ),
);
const samples = lock.samples.filter(
  (s) => filter === "all" || s.file === filter,
);
if (privatePhoto && filter === "all") {
  const bytes = await fs.readFile(privatePhoto);
  samples.push({
    file: "private-cat-reference.png",
    category: "animal",
    privatePath: privatePhoto,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inputLimitations: "用户提供的单张猫咪照片；私人素材仅保存在本机证据目录",
  });
}
const save = () =>
  fs.writeFile(
    path.join(directory, "category-report.json"),
    JSON.stringify(
      {
        samples: results,
        acceptedCategories: [],
        visualAcceptance: "pending-user-review",
      },
      null,
      2,
    ),
  );
async function api(url, data, headers = {}) {
  const response =
    data === undefined
      ? await context.get(url)
      : await context.post(url, {
          headers: { "X-Forma-Session": token, ...headers },
          data,
        });
  if (!response.ok()) throw new Error(`${url}: ${await response.text()}`);
  return response.json();
}
async function wait(job) {
  const end = Date.now() + 32 * 60 * 1000;
  let phase = "";
  while (Date.now() < end) {
    job = await api(`/api/jobs/${job.id}`);
    if (job.stage !== phase) {
      phase = job.stage;
      console.log(JSON.stringify({ jobId: job.id, stage: phase }));
    }
    if (["succeeded", "partial", "failed", "cancelled"].includes(job.status))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  await api(`/api/jobs/${job.id}/cancel`, {});
  throw new Error("Acceptance deadline reached; job cancelled");
}
try {
  for (const sample of samples) {
    const result = {
      file: sample.file,
      category: sample.category,
      inputLimitations: sample.inputLimitations,
      status: "started",
    };
    results.push(result);
    await save();
    try {
      const bytes = await fs.readFile(
        sample.privatePath || path.join(sampleDirectory, sample.file),
      );
      if (createHash("sha256").update(bytes).digest("hex") !== sample.sha256)
        throw new Error("Sample checksum mismatch");
      const project = await api("/api/projects", {
        name: `跨类别验收 · ${sample.category}`,
      });
      result.projectId = project.id;
      const attachment = await api(
        `/api/projects/${project.id}/attachments`,
        bytes,
        {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(sample.file),
        },
      );
      const prep = await wait(
        await api(`/api/projects/${project.id}/images/prepare`, {
          baseRevisionId: null,
          attachmentId: attachment.id,
        }),
      );
      if (prep.status !== "succeeded")
        throw new Error(prep.error || "Foreground failed");
      const snapshot = await api(`/api/projects/${project.id}/scene`);
      const image = snapshot.preparedImages.find(
        (i) => i.id === prep.preparedImageId,
      );
      result.preparedImageId = image.id;
      result.segmentationStatus = image.status;
      if (image.status !== "ready") {
        result.status = "needs-subject-selection";
        await save();
        continue;
      }
      const job = await wait(
        await api(`/api/projects/${project.id}/generate`, {
          baseRevisionId: null,
          route: "image3d",
          preparedImageId: image.id,
          prompt:
            "忠实还原主图中的单一主体，保留原有比例、部件数量、颜色和花纹。",
        }),
      );
      Object.assign(result, {
        status: job.status,
        jobId: job.id,
        error: job.error,
        qualitySummary: job.message,
        candidateArtifactId: job.candidateArtifactId,
        resultRevisionId: job.resultRevisionId,
      });
      const final = await api(`/api/projects/${project.id}/scene`);
      if (
        job.status !== "succeeded" &&
        final.project.currentRevisionId !== null
      )
        throw new Error("Failed candidate overwrote original");
    } catch (error) {
      result.status = "probe-failed";
      result.error = error.message;
    }
    await save();
    console.log(
      JSON.stringify({
        category: result.category,
        file: result.file,
        status: result.status,
        error: result.error,
      }),
    );
  }
} finally {
  await save();
  await context.dispose();
}
console.log("CATEGORY_PROBE_FINISHED");
