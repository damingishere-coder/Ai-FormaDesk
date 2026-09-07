// Actual surface editor + inference + version undo/export; no mocked endpoints.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
const [directory, pid, port = "8891"] = process.argv.slice(2);
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = `http://127.0.0.1:${port}`;
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.evaluate((pid) => localStorage.setItem("forma-project", pid), pid);
  await page.reload({ waitUntil: "networkidle" });
  const snapshot = () =>
    page.evaluate(
      async (pid) => await (await fetch(`/api/projects/${pid}/scene`)).json(),
      pid,
    );
  const before = await snapshot();
  const mesh = before.scene.objects.find(
    (o) => o.type === "MESH" && o.subjectId,
  );
  if (!mesh) throw new Error("No editable image mesh");
  await page.getByRole("button", { name: /^场景 ·/ }).click();
  await page.locator(`[data-object-id="${mesh.id}"]`).click();
  await page.getByRole("button", { name: "关闭场景列表" }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(directory, "before.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "精修表面", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "精修表面" });
  await modal.getByRole("button", { name: "框选", exact: true }).click();
  const box = await modal.getByLabel("表面精修选区").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
    steps: 12,
  });
  await page.mouse.up();
  await modal
    .getByLabel("精修要求")
    .fill(
      "减淡选区木纹，恢复自然浅棕色木质，坐垫保留原来的灰褐色，去除条纹和杂色。",
    );
  await page.screenshot({
    path: path.join(directory, "selection.png"),
    fullPage: true,
  });
  await modal.getByRole("button", { name: "开始精修", exact: true }).click();
  let job;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const s = await snapshot();
    if (s.activeJob) job = s.activeJob;
    if (job && !s.activeJob) {
      job = await page.evaluate(
        async (id) => await (await fetch(`/api/jobs/${id}`)).json(),
        job.id,
      );
      break;
    }
    await page.waitForTimeout(1200);
  }
  if (job?.status !== "succeeded") throw new Error(JSON.stringify(job));
  const after = await snapshot();
  if (after.project.currentRevisionId === before.project.currentRevisionId)
    throw new Error("No new revision");
  if (
    JSON.stringify(before.scene.objects.map((o) => [o.id, o.transform])) !==
    JSON.stringify(after.scene.objects.map((o) => [o.id, o.transform]))
  )
    throw new Error("Object identity or transform changed");
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(directory, "after.png"),
    fullPage: true,
  });
  // Exercise the same public restore API; exported GLB must include its atlas.
  const check = await page.evaluate(
    async ({ pid, before, after }) => {
      const { token } = await (await fetch("/api/session")).json();
      const headers = {
        "Content-Type": "application/json",
        "X-Forma-Session": token,
      };
      const revisions = await (
        await fetch(`/api/projects/${pid}/revisions`)
      ).json();
      const revision = revisions.find((r) => r.id === after);
      const response = await fetch(
        `/api/artifacts/${revision.artifacts.glb}?download=1`,
      );
      const bytes = await response.arrayBuffer();
      const view = new DataView(bytes);
      const doc = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(bytes, 20, view.getUint32(12, true)),
        ),
      );
      if (!doc.images?.some((i) => i.bufferView !== undefined))
        throw new Error("Export lost image texture");
      const undo = await fetch(`/api/projects/${pid}/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseRevisionId: after, action: "undo" }),
      });
      if (!undo.ok) throw new Error(await undo.text());
      const s = await (await fetch(`/api/projects/${pid}/scene`)).json();
      if (s.project.currentRevisionId !== before)
        throw new Error("Undo did not restore original");
      const redo = await fetch(`/api/projects/${pid}/restore`, {
        method: "POST",
        headers,
        body: JSON.stringify({ baseRevisionId: before, action: "redo" }),
      });
      if (!redo.ok) throw new Error(await redo.text());
      return {
        exportBytes: bytes.byteLength,
        embeddedImages: doc.images.length,
        undo: true,
        redo: true,
      };
    },
    {
      pid,
      before: before.project.currentRevisionId,
      after: after.project.currentRevisionId,
    },
  );
  if (errors.length) throw new Error(errors.join("\n"));
  await fs.writeFile(
    path.join(directory, "browser-report.json"),
    JSON.stringify(
      {
        pid,
        jobId: job.id,
        before: before.project.currentRevisionId,
        after: after.project.currentRevisionId,
        check,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("SURFACE_BROWSER_PROBE_OK");
} finally {
  await browser.close();
}
