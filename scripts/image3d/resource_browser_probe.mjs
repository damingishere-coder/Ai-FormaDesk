// Real workbench library previews; check explicit CPU bitmap and GPU disposal.
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const [output, pid, port = "8891"] = process.argv.slice(2);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.addInitScript((pid) => {
    localStorage.setItem("forma-project", pid);
    window.textureResources = { created: 0, closed: 0, gpuDeleted: 0 };
    const bitmaps = new WeakSet(),
      create = window.createImageBitmap,
      close = ImageBitmap.prototype.close;
    window.createImageBitmap = async (...args) => {
      const image = await create.apply(window, args);
      bitmaps.add(image);
      window.textureResources.created++;
      return image;
    };
    ImageBitmap.prototype.close = function () {
      if (bitmaps.has(this)) {
        bitmaps.delete(this);
        window.textureResources.closed++;
      }
      return close.call(this);
    };
    for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const original = type.prototype.deleteTexture;
      type.prototype.deleteTexture = function (texture) {
        if (texture) window.textureResources.gpuDeleted++;
        return original.call(this, texture);
      };
    }
  }, pid);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.textureResources.created > 0);
  await page.waitForTimeout(2200);
  const baseline = await page.evaluate(() => ({ ...window.textureResources }));
  await page.locator(".project-trigger").click();
  const library = page.getByRole("dialog", { name: "作品库" });
  const samples = [];
  for (let round = 0; round < 3; round++) {
    const previous = await page.evaluate(() => ({
      ...window.textureResources,
    }));
    await library.locator(".project-card.current .project-cover").click();
    await page.waitForFunction(
      (created) => window.textureResources.created > created,
      previous.created,
    );
    await page.waitForTimeout(1600);
    await library
      .getByRole("button", { name: "返回作品库", exact: true })
      .click();
    await page.waitForFunction(
      (closed) => window.textureResources.closed > closed,
      previous.closed,
    );
    await page.waitForTimeout(300);
    const sample = await page.evaluate(() => ({ ...window.textureResources }));
    samples.push(sample);
    assert.ok(sample.gpuDeleted > previous.gpuDeleted);
    assert.ok(
      sample.created - sample.closed <= baseline.created - baseline.closed + 1,
    );
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "resources-report.json"),
    JSON.stringify(
      {
        passed: true,
        baseline,
        samples,
        pageErrors: errors,
        scope:
          "three actual library preview mounts and unmounts; explicit bitmap/GPU release, not total process memory",
      },
      null,
      2,
    ),
  );
  console.log("RESOURCE_BROWSER_PROBE_OK");
} finally {
  await browser.close();
}
