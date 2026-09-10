import { test, expect } from "@playwright/test";
const day = "2026-09-09T00:00:00Z";
function fixture() {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`,
    coverRefreshSupported: true,
    name:
      i === 0
        ? "第四个作品"
        : i === 1
          ? "这是一个很长的中文作品名称用于检查卡片不会撑破布局和标题截断"
          : "作品 " + i,
    currentRevisionId: i === 7 ? null : `r${i}`,
    threadId: null,
    createdAt: day,
    updatedAt: day,
    redo: [],
    favorite: i === 2,
  }));
}
async function setup(page: any) {
  const ps = fixture();
  let sceneReads = 0;
  let opened = 0;
  const sources: string[] = [];
  await page.addInitScript(() => localStorage.setItem("forma-project", "p0"));
  await page.route("**/api/**", async (route: any) => {
    const req = route.request(),
      u = new URL(req.url()),
      p = u.pathname;
    if (p === "/api/session") return route.fulfill({ json: { token: "test" } });
    if (p === "/api/health")
      return route.fulfill({ json: { codex: true, blender: true } });
    if (p === "/api/projects" && req.method() === "POST") {
      const a = {
        ...ps[0],
        id: "created",
        name: req.postDataJSON().name,
        currentRevisionId: null,
      };
      ps.push(a);
      return route.fulfill({ json: a });
    }
    if (p === "/api/projects")
      return route.fulfill({
        json: ps.filter(
          (a: any) => !!a.deletedAt === (u.searchParams.get("trash") === "1"),
        ),
      });
    const m = p.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const a = ps.find((v) => v.id === m[1]) as any;
      const tail = m[2];
      if (!tail && req.method() === "DELETE") {
        expect(req.postDataJSON()).toEqual({ confirm: true });
        ps.splice(
          ps.findIndex((v) => v.id === a.id),
          1,
        );
        return route.fulfill({ json: { ok: true } });
      }
      if (!tail && req.method() === "PATCH") {
        Object.assign(a, req.postDataJSON());
        return route.fulfill({ json: a });
      }
      if (tail === "blender/source") {
        sources.push(a.id);
        return route.fulfill({ json: { opened: true, mode: "model" } });
      }
      if (tail === "blender/open") throw new Error("普通打开不应创建联动副本");
      if (tail === "opened") {
        opened++;
        return route.fulfill({ json: a });
      }
      if (tail === "trash" || tail === "untrash") {
        a.deletedAt = tail === "trash" ? day : null;
        return route.fulfill({ json: a });
      }
      if (tail === "files")
        return route.fulfill({
          json: [
            {
              id: "v1",
              projectId: a.id,
              revisionId: a.currentRevisionId,
              kind: "video",
              name: "零件组装 · 10秒",
              format: "MP4",
              url: "/api/artifacts/video",
              available: true,
              size: 2000,
              createdAt: day,
              current: true,
            },
            {
              id: "missing",
              projectId: a.id,
              revisionId: a.currentRevisionId,
              kind: "animation",
              name: "缺失动画",
              format: "BLEND",
              url: "",
              available: false,
              size: 0,
              createdAt: day,
              current: true,
            },
          ],
        });
      if (tail === "scene") {
        sceneReads++;
        return route.fulfill({
          json: {
            project: a,
            revision: null,
            scene: {
              objects: [],
              stats: { objects: 0, vertices: 0, triangles: 0 },
            },
            previewUrl: null,
            activeJob: null,
            jobs: [],
            messages: [],
            proposals: [],
            videos: [],
            render: null,
          },
        });
      }
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "全部作品", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".home-project")).toHaveCount(8);
  return { ps, sources, counts: () => ({ sceneReads, opened }) };
}
for (const [width, columns] of [
  [1280, 4],
  [1440, 4],
  [1920, 5],
  [480, 1],
])
  test(`首页 ${width}px 布局和不加载模型`, async ({ page }, info) => {
    const data = await setup(page);
    await page.setViewportSize({ width, height: 900 });
    expect(data.counts().sceneReads).toBe(0);
    const cols = await page
      .locator(".home-projects")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      );
    expect(cols).toBe(columns);
    const overflow = await page
      .locator(".home-main")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.screenshot({
      path: info.outputPath(`home-${width}.png`),
      fullPage: true,
    });
  });
test("搜索、收藏、排序、显示方式与重启保留", async ({ page }) => {
  await setup(page);
  await page.getByRole("textbox", { name: "搜索作品" }).fill("第四");
  await expect(page.locator(".home-project")).toHaveCount(1);
  await page
    .getByRole("button", { name: "收藏 第四个作品", exact: true })
    .click();
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(2);
  await page.getByLabel("作品排序").selectOption("name");
  await page.getByRole("button", { name: "列表视图", exact: true }).click();
  await page.reload();
  await expect(page.locator(".home-projects.list")).toBeVisible();
  await expect(page.getByLabel("作品排序")).toHaveValue("name");
  await page.getByRole("button", { name: "我的收藏", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(2);
});
test("直接打开、返回首页保留编辑器，文件侧栏和回收站可用", async ({ page }) => {
  const data = await setup(page);
  await page
    .getByRole("button", { name: "查看文件 第四个作品", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "作品文件", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("零件组装 · 10秒", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "在 Blender 中打开", exact: true }),
  ).toBeDisabled();
  expect(data.counts().sceneReads).toBe(0);
  await page.getByRole("button", { name: "关闭作品详情" }).click();
  await page
    .getByRole("button", { name: "打开 第四个作品", exact: true })
    .click();
  expect(data.sources).toEqual([]);
  await expect(page.locator(".project-home")).toHaveCount(0);
  await expect(page.locator(".project-trigger")).toContainText("第四个作品");
  expect(data.counts().sceneReads).toBe(1);
  await page.locator(".project-trigger").click();
  await expect(page.locator(".project-home")).toBeVisible();
  await page.getByRole("button", { name: "返回工作台" }).click();
  expect(data.counts().sceneReads).toBe(1);
  await page.locator(".project-trigger").click();
  await page.getByRole("button", { name: "管理 作品 3", exact: true }).click();
  await page.getByRole("menuitem", { name: "移入回收站", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(7);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(1);
  await page.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(0);
});

test("新建、重命名和彻底删除二次确认", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "新建作品", exact: true }).click();
  await page.getByLabel("新作品名称", { exact: true }).fill("新建验收作品");
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  await expect(page.locator(".project-trigger")).toContainText("新建验收作品");
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: "管理 新建验收作品", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByLabel("作品新名称", { exact: true }).fill("重命名后的作品");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开 重命名后的作品", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "管理 重命名后的作品", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await page
    .getByRole("button", { name: "彻底删除 重命名后的作品", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "确认彻底删除" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保留作品", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(1);
  await page
    .getByRole("button", { name: "彻底删除 重命名后的作品", exact: true })
    .click();
  await page.getByRole("button", { name: "确认彻底删除", exact: true }).click();
  await expect(page.locator(".home-project")).toHaveCount(0);
});

test("源文件入口独立打开 Blender，卡片和继续创作仍进入工作台", async ({
  page,
}) => {
  const data = await setup(page);
  await page
    .getByRole("button", { name: "管理 第四个作品", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "在 Blender 中打开源文件", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "在 Blender 中打开源文件",
  );
  expect(data.sources).toEqual(["p0"]);
  expect(data.counts().sceneReads).toBe(0);
  await expect(page.locator(".project-home")).toBeVisible();
  await page.locator(".home-resume").click();
  await expect(page.locator(".project-home")).toHaveCount(0);
  expect(data.counts().sceneReads).toBe(1);
  expect(data.sources).toEqual(["p0"]);
});

test("旧后台尚未重启时明确提示，不能假报封面刷新成功", async ({page}) => {
  const data = await setup(page);
  for (const p of data.ps) delete (p as any).coverRefreshSupported;
  await page.reload();
  await expect(page.getByText("封面更新已安装，需要重新启动应用后生效。请先等待当前后台任务完成。")).toBeVisible();
  await expect(page.getByRole("button",{name:"刷新封面",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"刷新封面 第四个作品",exact:true})).toBeDisabled();
});
