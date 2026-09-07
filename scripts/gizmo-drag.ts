import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const seed = JSON.parse(
  fs.readFileSync("data/acceptance/drag-seed.json", "utf8"),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  baseURL: "http://127.0.0.1:8765",
  viewport: { width: 1536, height: 1024 },
});
await page.addInitScript(
  (pid) => localStorage.setItem("forma-project", pid),
  seed.project.id,
);
await page.goto("http://127.0.0.1:8765");
await expect(page.locator(".project-trigger")).toContainText("木桌与绿灯");
const read = async () =>
  await (
    await page.request.get(`/api/projects/${seed.project.id}/scene`)
  ).json();
let before = await read();
const lamp = before.scene.objects.find(
  (o: any) => o.type === "EMPTY" && /台灯/.test(o.name),
);
await page.getByRole("button", { name: /^场景 ·/ }).click();
await page.locator(`[data-object-id="${lamp.id}"]`).click();
await page.getByRole("button", { name: "关闭场景列表" }).click();
await page.getByRole("button", { name: "移动", exact: true }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: "data/acceptance/drag-before.png" });
// Coordinates verified from the 1536x1024 screenshot of this persisted scene.
await page.mouse.move(1117, 439);
await page.mouse.down();
await page.mouse.move(1157, 447, { steps: 12 });
await page.mouse.up();
await expect
  .poll(async () => (await read()).project.currentRevisionId, {
    timeout: 30000,
  })
  .not.toBe(before.project.currentRevisionId);
const after = await read();
expect(
  after.scene.objects.find((o: any) => o.id === lamp.id).transform.position,
).not.toEqual(lamp.transform.position);
await expect(page.locator(".save-indicator")).not.toContainText("处理中");
await page.screenshot({ path: "data/acceptance/drag-after.png" });
await page.reload();
await expect(page.locator(".project-trigger")).toContainText("木桌与绿灯");
const reopened = await read();
expect(reopened.project.currentRevisionId).toBe(
  after.project.currentRevisionId,
);
await page.getByRole("button", { name: "撤销", exact: true }).click();
await expect
  .poll(async () => (await read()).project.currentRevisionId)
  .toBe(before.project.currentRevisionId);
fs.writeFileSync(
  "data/acceptance/drag-result.json",
  JSON.stringify(
    {
      passed: true,
      project: seed.project.id,
      objectId: lamp.id,
      before: lamp.transform,
      after: after.scene.objects.find((o: any) => o.id === lamp.id).transform,
      revision: after.project.currentRevisionId,
    },
    null,
    2,
  ),
);
await browser.close();
console.log("REAL_MOUSE_DRAG_PASSED");
