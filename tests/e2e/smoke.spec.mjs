import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#processPreset", { index: 1 });
  await page.click("#runBtn");
});

test("loads a preset, runs it and fills the comparison table", async ({ page }) => {
  const rows = page.locator("#leagueTable tbody tr");
  await expect(rows).toHaveCount(3); // FCFS, SJF and Round Robin are on by default
  await expect(rows.first()).toContainText("FCFS");
  await expect(page.locator("#leagueTable td.best").first()).toBeVisible();
  await expect(page.locator("#resultTable tbody tr")).not.toHaveCount(0);
});

test("step-through explains a dispatch", async ({ page }) => {
  await page.click("#stepNext");
  await expect(page.locator("#stepPanel")).toContainText("picks");
  await expect(page.locator("#clockReadout")).toContainText("t = 0");
});

test("runs without any API call", async ({ page }) => {
  const calls = [];
  page.on("request", (r) => r.url().includes("/api/") && calls.push(r.url()));
  await page.click("#runBtn");
  await expect(page.locator("#leagueTable tbody tr")).toHaveCount(3);
  expect(calls).toEqual([]);
});
