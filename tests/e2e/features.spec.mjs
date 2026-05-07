import { expect, test } from "@playwright/test";

const run = async (page) => {
  await page.click("#runBtn");
  await expect(page.locator("#leagueTable tbody tr").first()).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#processPreset", { index: 1 });
});

test("pins keep settings as their own tracks", async ({ page }) => {
  await page.locator("#algoChips input").evaluateAll((els) => els.forEach((e) => (e.checked = e.value === "RR")));
  await page.click("#pinBtn");
  await page.fill("#quantum", "4");
  await page.locator("#quantum").dispatchEvent("change");
  await page.click("#pinBtn");
  await run(page);
  const names = await page.locator("#leagueTable tbody tr td:first-child").allInnerTexts();
  expect(names).toContain("RR q=2 cs 1");
  expect(names).toContain("RR q=4 cs 1");
});

test("a shared link restores the workload and settings", async ({ page }) => {
  await page.fill("#quantum", "3");
  await page.locator("#quantum").dispatchEvent("change");
  await page.click("#pinBtn");
  await page.click("#shareBtn");
  const url = page.url();
  expect(url).toContain("#s=");
  await page.evaluate(() => localStorage.clear());
  await page.goto("about:blank");
  await page.goto(url);
  await expect(page.locator("#processTable tbody tr")).toHaveCount(4);
  await expect(page.locator("#quantum")).toHaveValue("3");
  await expect(page.locator("#pins")).toContainText("RR q=3");
  await expect(page.locator("#leagueTable tbody tr").first()).toBeVisible(); // ran by itself
});

test("a bad shared link is ignored with a message", async ({ page }) => {
  await page.goto("/#s=not-a-workload");
  await expect(page.locator(".toast.error")).toBeVisible();
});

test("the last workload is remembered", async ({ page }) => {
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator("#processTable tbody tr")).toHaveCount(4);
});

test("imports CSV and rejects a broken one", async ({ page }) => {
  const csv = "pid,arrival,burst,priority\nA,0,4,1\nB,1,2,2\n";
  await page.setInputFiles("#importFile", { name: "w.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.locator("#processTable tbody tr")).toHaveCount(2);
  await page.setInputFiles("#importFile", { name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("pid,arrival\nA,0\n") });
  await expect(page.locator(".toast.error")).toContainText("burst");
  await expect(page.locator("#processTable tbody tr")).toHaveCount(2);
});

test("exports JSON, CSV and PNG", async ({ page }) => {
  await run(page);
  const [json] = await Promise.all([page.waitForEvent("download"), page.click("#exportJsonBtn")]);
  expect(json.suggestedFilename()).toBe("cpu-schedule.json");
  await json.path(); // let it finish before the next download starts
  const [csv] = await Promise.all([page.waitForEvent("download"), page.click("#exportCsvBtn")]);
  expect(csv.suggestedFilename()).toBe("cpu-processes.csv");
  await csv.path();
  const [png] = await Promise.all([page.waitForEvent("download"), page.click("#pngBtn")]);
  expect(png.suggestedFilename()).toBe("timetable.png");
});

test("zoom and pan", async ({ page }) => {
  await run(page);
  await expect(page.locator("#panRange")).toBeHidden();
  await page.click("#zoomIn");
  await expect(page.locator("#panRange")).toBeVisible();
  await page.click("#zoomFit");
  await expect(page.locator("#panRange")).toBeHidden();
});

test("theme choice sticks across reloads", async ({ page }) => {
  await page.click("#themeBtn");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.click("#themeBtn");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
  await page.click("#themeBtn");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
});

test("edits a process in place", async ({ page }) => {
  await run(page);
  const burst = page.locator('input.cell[data-pid="P1"][data-field="burst"]');
  await burst.fill("9");
  await burst.dispatchEvent("change");
  await expect(page.locator("#staleBanner")).toBeVisible();
  await expect(burst).toHaveValue("9");
  await burst.fill("0");
  await burst.dispatchEvent("change");
  await expect(burst).toHaveValue("9"); // out of range: reverted
  await expect(page.locator(".toast.error")).toBeVisible();
});

test("every track has a text table", async ({ page }) => {
  await run(page);
  await page.locator("#altBox summary").click();
  await expect(page.locator("#altData tbody tr").first()).toBeVisible();
  await page.selectOption("#altTrack", { index: 1 });
  await expect(page.locator("#altData caption")).toContainText("SJF");
});
