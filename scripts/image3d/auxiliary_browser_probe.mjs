// Actual upload, Vision, auxiliary input and cancellation; no inference quality claim.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const [output, photo, port = "8892"] = process.argv.slice(2);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
let jobId, page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  const pid = await page.evaluate(async () => {
    const { token } = await (await fetch("/api/session")).json();
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forma-Session": token },
      body: JSON.stringify({ name: "辅助照片与取消验收" }),
    });
    if (!response.ok) throw new Error(await response.text());
    const project = await response.json();
    localStorage.setItem("forma-project", project.id);
    return project.id;
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("input[type=file]").setInputFiles(photo);
  await page
    .getByRole("button", { name: "准备主体", exact: true })
    .click({ timeout: 20000 });
  const modal = page.getByRole("dialog", { name: "准备建模主体" });
  await modal.waitFor({ timeout: 35 * 60 * 1000 });
  await modal.getByLabel("辅助参考图").setInputFiles(photo);
  await modal.locator(".auxiliary-reference").waitFor({ timeout: 20000 });
  const main = await modal.getByLabel("主体蒙版画布").getAttribute("width");
  assert.ok(Number(main) > 0);
  await page.screenshot({
    path: path.join(output, "auxiliary-editor.png"),
    fullPage: true,
  });
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/api/projects/${pid}/generate`),
      { timeout: 35 * 60 * 1000 },
    ),
    modal
      .getByRole("button", { name: "生成形体与表面候选", exact: true })
      .click({ timeout: 35 * 60 * 1000 }),
  ]);
  const submitted = response.request().postDataJSON();
  assert.equal(response.status(), 202, await response.text());
  const job = await response.json();
  jobId = job.id;
  assert.equal(submitted.attachmentIds.length, 1);
  const check = await page.evaluate(
    async ({ pid, jobId, auxiliaryId }) => {
      const { token } = await (await fetch("/api/session")).json();
      const headers = {
        "Content-Type": "application/json",
        "X-Forma-Session": token,
      };
      const cancel = await fetch(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!cancel.ok) throw new Error(await cancel.text());
      const remove = await fetch(
        `/api/projects/${pid}/attachments/${auxiliaryId}`,
        { method: "DELETE", headers },
      );
      const scene = await (await fetch(`/api/projects/${pid}/scene`)).json();
      return {
        usedAttachmentProtected: remove.status === 409,
        revisionId: scene.project.currentRevisionId,
      };
    },
    { pid, jobId, auxiliaryId: submitted.attachmentIds[0] },
  );
  assert.equal(check.usedAttachmentProtected, true);
  assert.equal(check.revisionId, null);
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "auxiliary-report.json"),
    JSON.stringify(
      {
        passed: true,
        pid,
        jobId,
        submitted,
        ...check,
        pageErrors: errors,
        generationCancelledIntentionally: true,
      },
      null,
      2,
    ),
  );
  console.log("AUXILIARY_BROWSER_PROBE_OK");
} finally {
  if (jobId && page && !page.isClosed())
    await page
      .evaluate(async (id) => {
        const { token } = await (await fetch("/api/session")).json();
        await fetch(`/api/jobs/${id}/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forma-Session": token,
          },
          body: "{}",
        });
      }, jobId)
      .catch(() => {});
  await browser.close();
}
