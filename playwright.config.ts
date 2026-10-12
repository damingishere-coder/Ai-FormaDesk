import { defineConfig } from "@playwright/test";
const port = Number(process.env.FORMA_MOCK_PORT || 19143);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8765, 5173].includes(port))
  throw new Error("FORMA_MOCK_PORT 必须是独立测试端口，不能使用 8765/5173");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/browser",
  testIgnore: ["**/v1.spec.ts", "**/v2.spec.ts", "**/v3.spec.ts", "**/render.spec.ts"],
  grepInvert: /@asset/,
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  retries: 0,
  outputDir: "test-results/mock",
  use: {
    channel: process.env.FORMA_BROWSER_CHANNEL === "chromium" ? undefined : "chrome",
    baseURL,
    viewport: { width: 1536, height: 1024 },
    serviceWorkers: "block",
    trace: "off",
  },
  webServer: {
    command: "node scripts/test-browser-mocks.mjs",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30000,
    env: { FORMA_MOCK_PORT: String(port) },
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/mock" }]],
});
