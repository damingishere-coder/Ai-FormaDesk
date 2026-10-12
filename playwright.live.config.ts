import { defineConfig } from "@playwright/test";
import { liveEnvironment } from "./tests/browser/live-environment";

const { dataDir, baseURL, port } = liveEnvironment();
export default defineConfig({
  testDir: "tests/browser",
  testMatch: ["**/v1.spec.ts", "**/v2.spec.ts", "**/v3.spec.ts", "**/render.spec.ts"],
  timeout: 900000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 0,
  outputDir: "test-results/live",
  use: {
    channel: "chrome",
    baseURL,
    viewport: { width: 1536, height: 1024 },
    serviceWorkers: "block",
    trace: "off",
  },
  // Always start this source checkout against the explicit isolated DATA.
  // An occupied URL fails; no existing desktop/backend instance is reused.
  webServer: {
    command: "npm run start",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
    env: { ZAOWU_DATA_DIR: dataDir, ZAOWU_PORT: String(port) },
  },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/live" }]],
});
