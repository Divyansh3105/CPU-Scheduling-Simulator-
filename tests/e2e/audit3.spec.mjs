import { expect, test } from "@playwright/test";

const load = (page, data) =>
  page.setInputFiles("#importFile", { name: "w.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("a very long timeline still draws every track", async ({ page }) => {
  await load(page, { processes: Array.from({ length: 20 }, (_, i) => ({ pid: "P" + i, arrival: 0, burst: 1000 })) });
  await page.locator("#algoChips input").evaluateAll((els) => els.forEach((e) => (e.checked = e.value === "RR")));
  await page.fill("#quantum", "1");
  await page.locator("#quantum").dispatchEvent("change");
  await page.click("#runBtn");
  await expect(page.locator("#leagueTable tbody tr")).toHaveCount(1);
  await page.waitForTimeout(1200);
  // painted pixels exist in the track area, so slivers were merged rather than dropped
  const painted = await page.evaluate(() => {
    const c = document.getElementById("timetable");
    const g = c.getContext("2d");
    const d = g.getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.55), 200, 4).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(100);
});

const hypervisorWorkload = {
  processes: [
    { pid: "A", arrival: 0, burst: 6, ioTime: 5, ioAt: [2], vm: "V" },
    { pid: "B", arrival: 0, burst: 10, vm: "V" },
  ],
  vms: [{ name: "V" }],
  settings: { algos: ["FCFS"], csOverhead: 0, hv: true, vmQuantum: 10, features: { enableIOScheduling: true } },
};

test("step-through works in hypervisor mode", async ({ page }) => {
  await load(page, hypervisorWorkload);
  await page.click("#runBtn");
  await expect(page.locator("#leagueTable tbody tr")).toHaveCount(1);
  await page.click("#stepNext");
  await expect(page.locator("#clockReadout")).toContainText("t = 0");
  await page.click("#stepNext");
  await expect(page.locator("#clockReadout")).not.toContainText("t = 0 ");
  await expect(page.locator("#stepPanel")).toContainText("on the CPU");
});

test("processes waiting on I/O are not listed as ready", async ({ page }) => {
  await load(page, hypervisorWorkload);
  await page.click("#runBtn");
  await expect(page.locator("#leagueTable tbody tr")).toHaveCount(1);
  await page.locator("#timetable").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("#stepPanel")).toContainText("Ready at t 4: nobody waiting"); // A is on the device until t 7, B is running
});

test("the Add form refuses a process that breaks the work cap", async ({ page }) => {
  await load(page, { processes: Array.from({ length: 20 }, (_, i) => ({ pid: "P" + i, arrival: 0, burst: 1000 })) }); // exactly at the cap
  await page.fill("#pid", "X");
  await page.fill("#arrival", "0");
  await page.fill("#burst", "1");
  await page.click('#processForm button[type="submit"]');
  await expect(page.locator(".toast.error")).toContainText("Total burst time");
  await expect(page.locator("#processTable tbody tr")).toHaveCount(20);
});

test("a damaged or oversized share link says so", async ({ page }) => {
  await page.goto("about:blank");
  await page.goto("/#s=" + "A".repeat(60001));
  await expect(page.locator(".toast.error")).toContainText("damaged or too long");
});

test("result tabs control a labelled tab panel", async ({ page }) => {
  await page.selectOption("#processPreset", { index: 1 });
  await page.click("#runBtn");
  const tab = page.locator('#detailTabs [role="tab"][aria-selected="true"]');
  await expect(tab).toHaveAttribute("aria-controls", "resultPanel");
  const id = await tab.getAttribute("id");
  await expect(page.locator("#resultPanel")).toHaveAttribute("role", "tabpanel");
  await expect(page.locator("#resultPanel")).toHaveAttribute("aria-labelledby", id);
});

test("the process table shows three-digit values in full and keeps the remove button visible", async ({ page }) => {
  await page.selectOption("#processPreset", { index: 1 });
  const clipped = await page.locator("#processTable input.cell").evaluateAll((els) =>
    els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => `${e.dataset.pid}.${e.dataset.field}=${e.value}`)
  );
  expect(clipped).toEqual([]);
  const aside = await page.locator("aside.workload").boundingBox();
  const last = await page.locator("#processTable .icon-btn").first().boundingBox();
  expect(last.x + last.width).toBeLessThanOrEqual(aside.x + aside.width);
});
