import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot, SceneObject } from "../../src/types";
const evidence = path.resolve("data/acceptance");
fs.mkdirSync(evidence, { recursive: true });
test("真实 Codex → Blender → 网页编辑 → 继续对话 → 版本恢复 → 渲染导出", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const session = await (await page.request.get("/api/session")).json();
  const headers = { "X-Forma-Session": session.token };
  const request = async (url: string, body?: unknown) => {
    const r =
      body === undefined
        ? await page.request.get("/api" + url)
        : await page.request.post("/api" + url, { data: body, headers });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await expect
    .poll(async () => (await request("/health")).ok, { timeout: 60000 })
    .toBe(true);
  // Start or resume the acceptance project through the visible project menu.
  const resume = process.env.FORMA_RESUME_PROJECT;
  if (
    !(await page
      .getByRole("dialog", { name: "作品库", exact: true })
      .isVisible())
  )
    await page.locator(".project-trigger").click();
  if (resume) {
    await page
      .getByRole("button", { name: /预览 木桌与绿灯 · V1 验收/ })
      .last()
      .click();
    await page.getByRole("button", { name: "打开编辑", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "新建作品", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新作品名称" })
      .fill("木桌与绿灯 · V1 验收");
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/projects") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    const createdProject = await (await created).json();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("forma-project")))
      .toBe(createdProject.id);
  }
  await expect(page.locator(".project-trigger")).toContainText("木桌与绿灯");
  const pid = (await page.evaluate(() =>
    localStorage.getItem("forma-project"),
  )) as string;
  const snap = async () =>
    (await request(`/projects/${pid}/scene`)) as Snapshot;
  async function settled() {
    await expect
      .poll(
        async () => {
          const s = await snap();
          return s.activeJob?.id || null;
        },
        { timeout: 900000, intervals: [1000, 2000, 4000] },
      )
      .toBe(null);
    await expect(page.locator(".save-indicator")).not.toContainText("处理中");
    const s = await snap();
    const text = await page.getByRole("alert").allTextContents();
    expect(text.join("")).toBe("");
    return s;
  }
  async function discussAndBuild() {
    const input = page.getByRole("textbox", { name: "创作想法" });
    await input.fill(
      (await input.inputValue()) + " 请采用合理默认值，直接给出可执行方案。",
    );
    await page.getByRole("button", { name: "发送讨论" }).click();
    const button = page
      .getByRole("button", { name: /^(开始建模|应用修改)$/ })
      .last();
    await expect(button).toBeEnabled({ timeout: 600000 });
    await button.click();
    await page.getByRole("button", { name: "收起创作对话" }).click();
  }
  async function perform(action: () => Promise<unknown>) {
    const prior = (await snap()).project.currentRevisionId;
    await action();
    await expect
      .poll(
        async () => {
          const s = await snap();
          return !!s.activeJob || s.project.currentRevisionId !== prior;
        },
        { timeout: 30000 },
      )
      .toBe(true);
    return settled();
  }
  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill("做一张木桌，桌上放一盏绿色台灯。");
  let s = resume ? await snap() : await perform(() => discussAndBuild());
  expect(s.scene.objects.length).toBeGreaterThan(4);
  const first = s.project.currentRevisionId!;
  console.log("FIRST_GENERATION", pid, first, s.scene.stats);
  fs.writeFileSync(
    path.join(evidence, "first-scene.json"),
    JSON.stringify(s, null, 2),
  );
  await page.screenshot({
    timeout: 15000,
    animations: "disabled",
    path: path.join(evidence, "model-1536.png"),
  });
  const lamp =
    s.scene.objects.find(
      (o) => o.type === "EMPTY" && /台灯|lamp/i.test(o.name),
    ) ||
    s.scene.objects.find((o) => o.type === "MESH" && /灯|lamp/i.test(o.name))!;
  const table =
    s.scene.objects.find(
      (o) => o.type === "EMPTY" && /桌|table/i.test(o.name),
    ) ||
    s.scene.objects.find((o) => o.type === "MESH" && /桌|table/i.test(o.name))!;
  const colored =
    s.scene.objects.find(
      (o) => o.type === "MESH" && o.material && /灯罩|shade/i.test(o.name),
    ) ||
    s.scene.objects.find(
      (o) => o.type === "MESH" && o.material && /灯|lamp/i.test(o.name),
    )!;
  expect(lamp).toBeTruthy();
  expect(table).toBeTruthy();
  expect(colored).toBeTruthy();
  async function select(o: SceneObject) {
    await page.getByRole("button", { name: /^场景 ·/ }).click();
    await page.locator(`[data-object-id="${o.id}"]`).click();
    await expect(
      page.getByRole("complementary", { name: "对象属性" }),
    ).toContainText(o.name);
    await page.getByRole("button", { name: "关闭场景列表", exact: true }).click();
  }
  await select(lamp);
  const moved = lamp.transform.position[0] + 0.35;
  s = await perform(async () => {
    await page
      .getByRole("spinbutton", { name: "位置 X", exact: true })
      .fill(String(moved));
    await page.getByRole("button", { name: "应用并保存" }).click();
  });
  expect(
    s.scene.objects.find((o) => o.id === lamp.id)!.transform.position[0],
  ).toBeCloseTo(moved, 4);
  s = await perform(async () => {
    await page
      .getByRole("spinbutton", { name: "旋转 Z", exact: true })
      .fill("15");
    await page.getByRole("button", { name: "应用并保存" }).click();
  });
  expect(
    s.scene.objects.find((o) => o.id === lamp.id)!.transform.rotation[2],
  ).toBeCloseTo(Math.PI / 12, 4);
  await select(table);
  s = await perform(async () => {
    await page
      .getByRole("spinbutton", { name: "缩放 X", exact: true })
      .fill("1.1");
    await page.getByRole("button", { name: "应用并保存" }).click();
  });
  await select(colored);
  await page.getByRole("button", { name: "外观", exact: true }).click();
  s = await perform(async () => {
    await page.getByRole("button", { name: "颜色 #2c455e" }).click();
    await page.getByRole("button", { name: "应用并保存" }).click();
  });
  expect(
    s.scene.objects.find((o) => o.id === colored.id)!.material!.color,
  ).toBe("#2c455e");
  const edited = s;
  console.log("MANUAL_EDIT_SAVED", s.project.currentRevisionId);
  fs.writeFileSync(
    path.join(evidence, "edited-scene.json"),
    JSON.stringify(s, null, 2),
  );
  await page.reload();
  await select(colored);
  await page.getByRole("button", { name: "外观", exact: true }).click();
  await expect(page.getByLabel("基础颜色")).toHaveValue("#2c455e");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    timeout: 15000,
    animations: "disabled",
    path: path.join(evidence, "properties-1280.png"),
  });
  const inspector = await page.locator(".inspector").boundingBox(),
    composer = await page.locator(".composer").boundingBox();
  expect(inspector!.x).toBeGreaterThan(composer!.x + composer!.width);
  // Input shortcuts must not change the active canvas tool.
  await page.getByRole("textbox", { name: "创作想法" }).fill("wer");
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toHaveClass(/active/);
  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill("增加一个杯子，保留已有对象的位置、旋转、缩放和颜色。");
  s = await perform(() => discussAndBuild());
  for (const id of [lamp.id, table.id, colored.id]) {
    const before = edited.scene.objects.find((o) => o.id === id)!,
      after = s.scene.objects.find((o) => o.id === id)!;
    expect(after).toBeTruthy();
    for (const key of ["position", "rotation", "scale"] as const)
      after.transform[key].forEach((v, i) =>
        expect(v).toBeCloseTo(before.transform[key][i], 4),
      );
    expect(after.material).toEqual(before.material);
  }
  expect(s.scene.objects.length).toBeGreaterThan(edited.scene.objects.length);
  const withCup = s.project.currentRevisionId!;
  console.log("CONTINUED_AI_PRESERVES_EDITS", withCup);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .toBe(edited.project.currentRevisionId);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .toBe(withCup);
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page
    .locator(".revision-list>div")
    .filter({ hasText: "做一张木桌" })
    .getByRole("button", { name: "恢复" })
    .click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .toBe(first);
  await page.getByRole("button", { name: "关闭窗口" }).click();
  // Restore saved edits and continue from that historical branch.
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page
    .locator(".revision-list>div")
    .filter({ hasText: edited.project.currentRevisionId!.slice(0, 8) })
    .getByRole("button", { name: "恢复" })
    .click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .toBe(edited.project.currentRevisionId);
  await page.getByRole("button", { name: "关闭窗口" }).click();
  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill("在当前版本的桌上增加一个小杯子，保留已有物件的变换和颜色。");
  s = await perform(() => discussAndBuild());
  expect(s.revision!.parentId).toBe(edited.project.currentRevisionId);
  expect(
    (await request(`/projects/${pid}/revisions`)).some(
      (r: any) => r.id === withCup,
    ),
  ).toBe(true);
  console.log("HISTORY_BRANCH", s.project.currentRevisionId);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page
    .getByRole("button", { name: "关闭属性面板" })
    .click()
    .catch(() => {});
  await page.getByRole("combobox", { name: "观察视角" }).selectOption("front");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page
    .getByRole("button", { name: "生成图片", exact: true })
    .click();
  await expect
    .poll(
      async () => {
        const v = await snap();
        if (!v.activeJob) {
          const alerts = await page.getByRole("alert").allTextContents();
          if (alerts.length) throw new Error(alerts.join(""));
        }
        return v.render?.revisionId;
      },
      { timeout: 240000 },
    )
    .toBe(s.project.currentRevisionId);
  s = await settled();
  expect(s.render!.camera.position[0]).toBeCloseTo(
    s.render!.camera.target[0],
    4,
  );
  expect(s.render!.camera.position[1]).toBeCloseTo(
    s.render!.camera.target[1],
    4,
  );
  await expect(
    page.getByAltText("Blender 成品图", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    timeout: 15000,
    animations: "disabled",
    path: path.join(evidence, "render-1536.png"),
  });
  await page.getByRole("button", { name: "关闭成品图" }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  for (const title of ["Blender 源文件", "通用三维模型", "下载原图"]) {
    if (title === "下载原图")
      await page.getByRole("tab", { name: "图片", exact: true }).click();
    else {
      await page.getByRole("tab", { name: "模型", exact: true }).click();
      await page.getByRole("radio", { name: new RegExp(title) }).check();
    }
    const download = page.waitForEvent("download");
    await page.getByRole("link").filter({ hasText: title === "下载原图" ? title : "下载模型" }).click();
    const d = await download;
    await d.saveAs(path.join(evidence, d.suggestedFilename()));
    expect(await d.failure()).toBe(null);
  }
  await page.getByRole("button", { name: "返回工作台" }).click();
  fs.writeFileSync(
    path.join(evidence, "final-scene.json"),
    JSON.stringify(s, null, 2),
  );
  // A new saved modification must stale the previous image.
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await select(s.scene.objects.find((o) => o.id === colored.id)!);
  await page.getByRole("button", { name: "变换", exact: true }).click();
  s = await perform(() =>
    page.getByRole("button", { name: "应用并保存" }).click(),
  );
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "查看成品图", exact: true }).click();
  await expect(page.locator(".render-caption")).toContainText("需要重新渲染");
  // Return to the rendered version as a clean, reviewable final state.
  await request(`/projects/${pid}/restore`, {
    baseRevisionId: s.project.currentRevisionId,
    revisionId: s.render!.revisionId,
    action: "restore",
  });
  await page.reload();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "查看成品图", exact: true }).click();
  expect(errors).toEqual([]);
  fs.writeFileSync(
    path.join(evidence, "browser-result.json"),
    JSON.stringify(
      {
        passed: true,
        pid,
        first,
        edited: edited.project.currentRevisionId,
        withCup,
        finalRevision: s.render!.revisionId,
        errors,
      },
      null,
      2,
    ),
  );
  console.log("BROWSER_V1_PASSED", pid);
});
