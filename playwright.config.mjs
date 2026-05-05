import { defineConfig } from "@playwright/test";

// The page runs on the JavaScript engine, so any static server works; PHP is already a project dependency.
export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:8099",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined }, // optional: reuse an installed Chromium
  },
  webServer: {
    command: "php -S 127.0.0.1:8099 -t public",
    url: "http://127.0.0.1:8099/",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
  },
});
