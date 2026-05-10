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

const bigWorkload = (page) =>
  page.setInputFiles("#importFile", {
    name: "big.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ processes: Array.from({ length: 100 }, (_, i) => ({ pid: "P" + i, arrival: Math.floor(i / 2), burst: 2 + (i % 7) })) })),
  });

test("the wheel scrolls the text table and the legend, not the page", async ({ page }) => {
  await bigWorkload(page);
  await run(page);
  await page.locator("#altBox summary").click();
  for (const sel of ["#altData", "#legend"]) {
    const el = page.locator(sel);
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const box = await el.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 30);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => el.evaluate((e) => e.scrollTop), { message: sel }).toBeGreaterThan(0);
  }
});

test("shift + wheel pans the chart without scrolling the page", async ({ page }) => {
  await bigWorkload(page);
  await run(page);
  await page.click("#zoomIn");
  await page.click("#zoomIn");
  await page.locator("#timetable").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const box = await page.locator("#timetable").boundingBox();
  const before = { y: await page.evaluate(() => scrollY), pan: await page.locator("#panRange").inputValue() };
  await page.mouse.move(box.x + 400, box.y + 120);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 200);
  await page.keyboard.up("Shift");
  await page.waitForTimeout(600);
  expect(await page.locator("#panRange").inputValue()).not.toBe(before.pan);
  expect(await page.evaluate(() => scrollY)).toBe(before.y);
});

test("a new run resets the zoom controls", async ({ page }) => {
  await run(page);
  await page.click("#zoomIn");
  await page.click("#runBtn");
  await expect(page.locator("#panRange")).toBeHidden();
  await expect(page.locator("#zoomFit")).toBeDisabled();
});

test("the text table starts capped again after a new run", async ({ page }) => {
  await page.setInputFiles("#importFile", {
    name: "long.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ processes: Array.from({ length: 100 }, (_, i) => ({ pid: "P" + i, arrival: 0, burst: 20 })) })),
  });
  await page.locator("#algoChips input").evaluateAll((els) => els.forEach((e) => (e.checked = e.value === "RR")));
  await page.fill("#quantum", "1");
  await page.locator("#quantum").dispatchEvent("change");
  await run(page);
  await page.locator("#altBox summary").click();
  await page.click("#altMore");
  const all = await page.locator("#altData tbody tr").count();
  expect(all).toBeGreaterThan(1000);
  await page.click("#runBtn");
  await expect(page.locator("#altData tbody tr")).toHaveCount(1000);
});

test("a semicolon CSV gets a clear message and changes nothing", async ({ page }) => {
  await page.setInputFiles("#importFile", { name: "semi.csv", mimeType: "text/csv", buffer: Buffer.from("pid;arrival;burst\nA;0;3\n") });
  await expect(page.locator(".toast.error")).toContainText("separated by commas");
  await expect(page.locator("#processTable tbody tr")).toHaveCount(4);
});

test("a bad settings block leaves the workload untouched", async ({ page }) => {
  const bad = { processes: [{ pid: "Z", arrival: 0, burst: 2 }], settings: { algos: 5, features: "x" } };
  await page.setInputFiles("#importFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
  await expect(page.locator("#processTable tbody tr")).toHaveCount(1); // the process list is valid, the odd settings are ignored
  await expect(page.locator(".toast.error")).toHaveCount(0);
});

test("pinning at the limit shows one message", async ({ page }) => {
  await page.locator("#algoChips input").evaluateAll((els) => els.forEach((e) => (e.checked = true)));
  await page.click("#pinBtn"); // 7 algorithms, 6 fit
  await expect(page.locator(".toast.error")).toHaveCount(1);
});

test("editing the burst keeps the I/O points hint current", async ({ page }) => {
  await page.setInputFiles("#importFile", {
    name: "io.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ processes: [{ pid: "Q", arrival: 0, burst: 10, ioTime: 1, ioAt: [2, 5] }] })),
  });
  const row = page.locator("#processTable tbody tr", { hasText: "Q" });
  await expect(row.locator(".hint")).toHaveText("@2,5");
  const burst = row.locator('input[data-field="burst"]');
  await burst.fill("4");
  await burst.dispatchEvent("change");
  await expect(row.locator(".hint")).toHaveText("@2"); // point 5 no longer fits inside a burst of 4
});

test("names that exist on every JS object work", async ({ page }) => {
  await page.setInputFiles("#importFile", {
    name: "names.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ processes: [{ pid: "constructor", arrival: 0, burst: 3 }, { pid: "toString", arrival: 1, burst: 2 }] })),
  });
  await run(page);
  await page.locator("#altBox summary").click();
  await expect(page.locator("#resultTable tbody tr").first()).toContainText("constructor");
  await expect(page.locator("#resultTable tbody tr td").nth(7)).not.toHaveText(/NaN|null/);
});
