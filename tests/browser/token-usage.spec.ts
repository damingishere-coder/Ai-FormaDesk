import { test, expect } from "@playwright/test";

for (const width of [1280, 768, 390]) {
  test(`作品卡片用量、未知值与窄屏布局 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/session") return route.fulfill({ json: { token: "fixture" } });
      if (url.pathname === "/api/projects") return route.fulfill({ json: [
        { totalTokens: 12500, partial: false },
        { totalTokens: 1200000, partial: true },
        null,
        { totalTokens: 0, partial: false },
      ].map((tokenUsage, i) => ({
        id: `project-${i}`, name: ["火车头", "自行车", "旧作品", "新作品"][i],
        threadId: null, currentRevisionId: null, redo: [],
        createdAt: "2026-09-09T00:00:00Z", tokenUsage,
      })) });
      return route.fulfill({ json: {} });
    });
    await page.goto(process.env.TOKEN_UI_BASE || "/");
    const labels = page.locator(".home-project-tokens");
    await expect(labels).toHaveText(["12.5K tokens", "≥1.2M tokens", "Token 未统计", "0 tokens"]);
    await expect(labels.nth(1)).toHaveAttribute("title", /历史或部分调用记录不完整/);
    expect(await labels.evaluateAll(elements => elements.every(el => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`token-cards-${width}.png`), fullPage: true });
  });
}
