import { requireLiveEnvironment } from "./require-live-environment";
const live = requireLiveEnvironment({ http: true });
const DATA = live.dataDir;
import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const screenshots = path.join(DATA, "screenshots");
fs.mkdirSync(screenshots, { recursive: true });
const seed = JSON.parse(
  fs.readFileSync(path.join(DATA, "acceptance", "final-scene.json"), "utf8"),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  baseURL: live.baseURL!,
  viewport: { width: 1536, height: 1024 },
});
await page.addInitScript(
  (pid) => localStorage.setItem("forma-project", pid),
  seed.project.id,
);
await page.goto("/");
await page.getByRole("textbox", { name: "建模需求" }).waitFor();
await expect
  .poll(async () => {
    const s = await (
      await page.request.get(`/api/projects/${seed.project.id}/scene`)
    ).json();
    return s.activeJob;
  })
  .toBe(null);
await page.waitForTimeout(700);
const s = await (
  await page.request.get(`/api/projects/${seed.project.id}/scene`)
).json();
const obj = s.scene.objects.find(
  (o: any) => o.type === "MESH" && /灯罩/.test(o.name),
);
await page.getByRole("button", { name: /^场景 ·/ }).click();
await page.locator(`[data-object-id="${obj.id}"]`).click();
await page.getByRole("button", { name: "关闭场景列表" }).click();
await page.getByRole("button", { name: "外观", exact: true }).click();
await page.screenshot({ path: path.join(screenshots, "workbench.png") });
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: path.join(screenshots, "workbench-1280.png") });
await page.setViewportSize({ width: 1536, height: 1024 });
await page.getByRole("button", { name: "渲染预览", exact: true }).click();
const rendered = page.getByAltText("当前保存版本的真实 Blender 渲染");
await expect
  .poll(() =>
    rendered.evaluate(
      (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
    ),
  )
  .toBe(true);
await page.screenshot({ path: path.join(screenshots, "render.png") });
fs.writeFileSync(
  path.join(DATA, "acceptance", "delivery-scene.json"),
  JSON.stringify(s, null, 2),
);
await browser.close();
console.log("DELIVERY_SCREENSHOTS_CAPTURED");
