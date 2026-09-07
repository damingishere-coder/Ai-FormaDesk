// Exercises the actual isolated workbench, never substitutes generation APIs.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
const [directory, photo, port = "8891"] = process.argv.slice(2);
if (!directory || !photo)
  throw new Error("Need evidence directory and public reference photo");
await fs.mkdir(directory, { recursive: true });
const origin = `http://127.0.0.1:${Number(port)}`;
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  const pid = await page.evaluate(async () => {
    const { token } = await (await fetch("/api/session")).json();
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forma-Session": token },
      body: JSON.stringify({ name: "真实图生建模验收" }),
    });
    if (!r.ok) throw new Error(await r.text());
    const p = await r.json();
    localStorage.setItem("forma-project", p.id);
    return p.id;
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("input[type=file]").setInputFiles(photo);
  await page
    .getByRole("button", { name: "准备主体", exact: true })
    .click({ timeout: 20000 });
  const modal = page.getByRole("dialog", { name: "准备建模主体" });
  await modal.waitFor({ timeout: 120000 });
  await modal.getByRole("button", { name: "保存主体", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "保存主体",
      )?.disabled,
  );
  const canvas = modal.getByLabel("主体蒙版画布");
  const box = await canvas.boundingBox();
  await modal.getByRole("button", { name: "去除", exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.8, {
    steps: 5,
  });
  await page.mouse.up();
  await page.screenshot({
    path: path.join(directory, "mask-editor.png"),
    fullPage: true,
  });
  await modal.getByRole("button", { name: "保存主体", exact: true }).click();
  await page.waitForFunction(
    async (pid) =>
      (await (await fetch(`/api/projects/${pid}/scene`)).json()).preparedImages
        ?.length >= 2,
    pid,
  );
  await modal
    .getByRole("button", { name: "生成形体与表面候选", exact: true })
    .click();
  let candidateSeen = false,
    final;
  const until = Date.now() + 30 * 60 * 1000;
  while (Date.now() < until) {
    const snapshot = await page.evaluate(
      async (pid) => await (await fetch(`/api/projects/${pid}/scene`)).json(),
      pid,
    );
    const jobs = snapshot.candidates || [];
    if (snapshot.activeJob?.candidateArtifactId && !candidateSeen) {
      candidateSeen = true;
      console.log("LIVE_SHAPE_CANDIDATE");
      await page.waitForTimeout(1800);
      await page.screenshot({
        path: path.join(directory, "shape-candidate.png"),
        fullPage: true,
      });
    }
    if (!snapshot.activeJob && jobs.length) {
      final = { snapshot, job: jobs.at(-1) };
      break;
    }
    const alert = await page.getByRole("alert").allTextContents();
    if (!snapshot.activeJob && alert.length) throw new Error(alert.join("\n"));
    await page.waitForTimeout(1500);
  }
  if (!final)
    throw new Error("Workbench inference did not produce a terminal candidate");
  if (
    !["partial", "succeeded"].includes(final.job.status) ||
    !final.job.candidateManifest
  )
    throw new Error(JSON.stringify(final.job));
  if (
    final.job.status === "partial" &&
    final.snapshot.project.currentRevisionId !== null
  )
    throw new Error("Incomplete candidate replaced the project revision");
  await page.waitForTimeout(2200);
  await page.screenshot({
    path: path.join(directory, "textured-candidate.png"),
    fullPage: true,
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "查看候选", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: path.join(directory, "restored-candidate.png"),
    fullPage: true,
  });
  let adopted = false;
  if (final.job.status === "partial") {
    await page
      .getByRole("button", { name: "保存为可编辑版本", exact: true })
      .click();
    await page.waitForFunction(
      async (pid) => {
        const s = await (await fetch(`/api/projects/${pid}/scene`)).json();
        return !s.activeJob && !!s.project.currentRevisionId;
      },
      pid,
      { timeout: 60000 },
    );
    adopted = true;
  }
  const saved = await page.evaluate(
    async (pid) => await (await fetch(`/api/projects/${pid}/scene`)).json(),
    pid,
  );
  if (!saved.project.currentRevisionId || !saved.scene.objects.length)
    throw new Error("Editable version was not saved");
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(directory, "editable-version.png"),
    fullPage: true,
  });
  if (errors.length) throw new Error(errors.join("\n"));
  await fs.writeFile(
    path.join(directory, "app-report.json"),
    JSON.stringify(
      {
        pid,
        jobId: final.job.id,
        candidateSeenWhileRunning: candidateSeen,
        maskSaved: true,
        originalRevisionPreservedUntilValidatedOrAdopted: true,
        generationStatus: final.job.status,
        adopted,
        revisionId: saved.project.currentRevisionId,
        candidateRecoveredOnReload: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("APP_PROBE_OK");
} finally {
  await browser.close();
}
