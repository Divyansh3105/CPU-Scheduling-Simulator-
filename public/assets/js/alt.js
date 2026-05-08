// Text alternative to the canvas: every track as a plain table of what ran, when and where.
// Rendered only while the section is open, and capped so a 50k-segment run cannot stall the page.
import { $, esc, fmtTime, state } from "./state.js";

const ROW_CAP = 1000;
const NAMES = { IDLE: "Idle", CS: "Context switch", MIGRATION: "Migration", NUMA: "NUMA hop" };
let showAll = false;
let shownRuns = null;

export function renderAlt() {
  if (shownRuns !== state.runs) {
    shownRuns = state.runs;
    showAll = false;
  }
  const box = $("altData");
  $("altBox").hidden = !state.runs.length;
  if (!state.runs.length || !$("altBox").open) return;

  const select = $("altTrack");
  const keep = state.runs.some((r) => r.algo === select.value) ? select.value : state.selected;
  select.innerHTML = state.runs.map((r) => `<option value="${r.algo}">${esc(r.label)}</option>`).join("");
  select.value = keep;

  const run = state.runs.find((r) => r.algo === select.value) ?? state.runs[0];
  const segs = run.data.segments;
  const rows = showAll ? segs : segs.slice(0, ROW_CAP);
  box.innerHTML =
    `<table class="data"><caption>${esc(run.label)}: ${segs.length} entries in time order</caption>` +
    `<thead><tr><th scope="col" class="num">Start</th><th scope="col" class="num">End</th><th scope="col">Ran</th><th scope="col">VM</th></tr></thead><tbody>` +
    rows
      .map((s) => `<tr><td class="num">${fmtTime(s.start)}</td><td class="num">${fmtTime(s.end)}</td><td>${esc(NAMES[s.pid] ?? s.pid)}</td><td>${esc(s.vm || "")}</td></tr>`)
      .join("") +
    `</tbody></table>` +
    (segs.length > rows.length ? `<button type="button" class="btn btn-quiet" id="altMore">Show all ${segs.length} entries</button>` : "");
  $("altMore")?.addEventListener("click", () => {
    showAll = true;
    renderAlt();
  });
}

$("altBox").addEventListener("toggle", renderAlt);
$("altTrack").addEventListener("change", () => {
  showAll = false;
  renderAlt();
});
