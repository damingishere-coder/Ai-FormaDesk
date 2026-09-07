import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 900000,
  expect: { timeout: 20000 },
  workers: 1,
  use: {
    channel: "chrome",
    baseURL: "http://127.0.0.1:8765",
    viewport: { width: 1536, height: 1024 },
    trace: "off",
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
