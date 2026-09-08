import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const directory = path.resolve(process.argv[2]),
  port = Number(process.argv[3] || 8896);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const hash = (b) => createHash("sha256").update(b).digest("hex");
const rows = JSON.parse(
  await fs.readFile(path.join(directory, "summary.json"), "utf8"),
);
for (const row of rows.filter((r) => r.glb)) {
  const response = await fetch(origin + "/" + row.glb, { redirect: "error" });
  assert.equal(response.status, 200);
  assert.equal(
    hash(Buffer.from(await response.arrayBuffer())),
    hash(await fs.readFile(path.join(directory, row.glb))),
  );
}
const browser = await chromium.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
  });
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
  );
  await context.addInitScript(() => {
    const buffers = new Set(),
      textures = new Set();
    for (const cls of [WebGLRenderingContext, WebGL2RenderingContext])
      for (const [name, set] of [
        ["Buffer", buffers],
        ["Texture", textures],
      ]) {
        const make = cls.prototype["create" + name],
          remove = cls.prototype["delete" + name];
        cls.prototype["create" + name] = function (...args) {
          const value = make.apply(this, args);
          if (value) set.add(value);
          return value;
        };
        cls.prototype["delete" + name] = function (value) {
          set.delete(value);
          return remove.call(this, value);
        };
      }
    window.previewAllocations = () => ({
      buffers: buffers.size,
      textures: textures.size,
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  const select = page.locator("#viewer-select"),
    status = page.locator("#viewer-status"),
    canvas = page.locator("#viewer canvas");
  await status.filter({ hasText: "三角面" }).waitFor();
  const baseline = await page.evaluate(() => window.previewAllocations()),
    loads = [];
  for (const row of rows.filter((r) => r.glb)) {
    await select.selectOption(row.glb);
    await status.filter({ hasText: "三角面" }).waitFor();
    const triangles = Number(
      (await status.textContent()).split(" ")[0].replaceAll(",", ""),
    );
    assert.ok(triangles > 0 && triangles <= 150000);
    loads.push({ sample: row.sample, triangles });
    const before = await canvas.screenshot(),
      box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.55, {
      steps: 15,
    });
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert.notEqual(hash(before), hash(await canvas.screenshot()));
  }
  await select.selectOption(rows.find((r) => r.glb).glb);
  await status.filter({ hasText: "三角面" }).waitFor();
  const afterSwitches = await page.evaluate(() => window.previewAllocations());
  assert.ok(afterSwitches.buffers <= baseline.buffers + 5);
  assert.ok(afterSwitches.textures <= baseline.textures + 2);
  await page.screenshot({
    path: path.join(directory, "browser-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= innerWidth,
    undefined,
    { timeout: 5000 },
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(directory, "browser-mobile.png"),
    fullPage: true,
  });
  assert.equal(errors.length, 0);
  await fs.writeFile(
    path.join(directory, "browser-report.json"),
    JSON.stringify(
      {
        passed: true,
        loads,
        rotation: true,
        servedGlbHashesMatch: true,
        baseline,
        afterSwitches,
        pageErrors: errors,
        mobileOverflow: false,
        browser: await browser.version(),
        scope: "isolated report viewer, not full workbench UI regression",
      },
      null,
      2,
    ),
  );
  console.log("STYLIZED_BROWSER_OK");
} finally {
  await browser.close();
}
