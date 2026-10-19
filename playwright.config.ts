import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  retries: 0,
  timeout: 45000,
  outputDir: "test-results/browser",
  reporter: [["list"], ["html", { open: "never" }], ["json", { outputFile: "test-results/browser-results.json" }],
    ["junit", { outputFile: "test-results/browser-results.xml" }]],
  use: { browserName: "chromium", ignoreHTTPSErrors: true,
    screenshot: "only-on-failure", video: "retain-on-failure", trace: "retain-on-failure" },
});
