import { chromium, expect } from "@playwright/test";
import fs from "node:fs";
const s = JSON.parse(
    fs.readFileSync("data/acceptance/final-scene.json", "utf8"),
  ),
  pid = s.project.id;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  baseURL: "http://127.0.0.1:8765",
  viewport: { width: 1280, height: 800 },
});
await page.addInitScript((p) => localStorage.setItem("forma-project", p), pid);
await page.goto("/");
await page.getByRole("textbox", { name: "建模需求" }).waitFor();
const { token } = await (await page.request.get("/api/session")).json();
const read = async () =>
  await (await page.request.get(`/api/projects/${pid}/scene`)).json();
const original = await read();
async function select(id: string) {
  await page.getByRole("button", { name: /^场景 ·/ }).click();
  await page.locator(`[data-object-id="${id}"]`).click();
  await page.getByRole("button", { name: "关闭场景列表" }).click();
}
async function act(name: string) {
  const old = (await read()).project.currentRevisionId;
  await page.getByRole("button", { name, exact: true }).click();
  await expect
    .poll(async () => (await read()).project.currentRevisionId, {
      timeout: 30000,
    })
    .not.toBe(old);
  await expect(page.locator(".save-indicator")).not.toContainText("处理中");
  expect(await page.getByRole("alert").allTextContents()).toEqual([]);
  return read();
}
try {
  const mesh = original.scene.objects.find((o: any) => o.type === "MESH");
  await select(mesh.id);
  const duplicated = await act("复制对象");
  expect(duplicated.scene.objects.length).toBe(
    original.scene.objects.length + 1,
  );
  const copy = duplicated.scene.objects.find(
    (o: any) => !original.scene.objects.some((p: any) => p.id === o.id),
  );
  expect(copy.name).toContain(mesh.name);
  await select(copy.id);
  expect(await page.locator(".selection-chip").innerText()).toContain(
    copy.name,
  );
  const hidden = await act("隐藏对象");
  expect(hidden.scene.objects.find((o: any) => o.id === copy.id).visible).toBe(
    false,
  );
  const shown = await act("显示对象");
  expect(shown.scene.objects.find((o: any) => o.id === copy.id).visible).toBe(
    true,
  );
  const deleted = await act("删除对象");
  expect(deleted.scene.objects.some((o: any) => o.id === copy.id)).toBe(false);
  expect(deleted.scene.objects.some((o: any) => o.id === mesh.id)).toBe(true);
  const light = deleted.scene.objects.find((o: any) => o.type === "LIGHT");
  await select(light.id);
  await page.getByRole("button", { name: "灯光", exact: true }).click();
  await page.getByRole("spinbutton", { name: "灯光强度" }).fill("123");
  await page.getByLabel("灯光颜色").fill("#ffe0c0");
  const lit = await act("应用并保存");
  expect(
    lit.scene.objects.find((o: any) => o.id === light.id).light,
  ).toMatchObject({ energy: 123, color: "#ffe0c0" });
  fs.writeFileSync(
    "data/acceptance/object-actions-result.json",
    JSON.stringify(
      {
        passed: true,
        project: pid,
        original: mesh.id,
        duplicate: copy.id,
        light: light.id,
        operations: [
          "duplicate",
          "distinct-ID-selection",
          "hide",
          "show",
          "delete",
          "light",
        ],
      },
      null,
      2,
    ),
  );
  console.log("OBJECT_ACTIONS_PASSED");
} finally {
  const cur = await read();
  await page.request.post(`/api/projects/${pid}/restore`, {
    headers: { "X-Forma-Session": token },
    data: {
      baseRevisionId: cur.project.currentRevisionId,
      revisionId: original.project.currentRevisionId,
      action: "restore",
    },
  });
  await browser.close();
}
