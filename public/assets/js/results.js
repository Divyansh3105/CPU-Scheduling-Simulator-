import { drawChart, renderReadout, setHover } from "./chart.js";
import { $, ALGO_LABELS, colorFor, esc, fmt, fmtTime, paint, state } from "./state.js";
import { renderStep } from "./stepper.js";

/* ---------------- Results ---------------- */

export function renderResults() {
  $("chartEmpty").hidden = state.runs.length > 0;
  $("leagueSection").hidden = !state.runs.length;
  $("detailSection").hidden = !state.runs.length;
  renderLeague();
  renderLegend();
  renderDetail();
  renderReadout();
  renderStep();
  drawChart();
}

export const LEAGUE_COLS = [
  { key: "turnaround", better: "min", digits: 2 },
  { key: "waiting", better: "min", digits: 2 },
  { key: "response", better: "min", digits: 2 },
  { key: "throughput", better: "max", digits: 3 },
  { key: "busy", better: "max", digits: 1, suffix: "%" },
  { key: "switches", better: "min", digits: 0 },
  { key: "migrations", better: null, digits: 0, hvOnly: true },
];

export function renderLeague() {
  const tbody = document.querySelector("#leagueTable tbody");
  const best = {};
  LEAGUE_COLS.forEach((c) => {
    if (!c.better || state.runs.length < 2) return;
    const values = state.runs.map((r) => r.metrics[c.key]);
    const target = c.better === "min" ? Math.min(...values) : Math.max(...values);
    if (values.some((v) => v !== target)) best[c.key] = target;
  });

  tbody.innerHTML = state.runs
    .map((r) => {
      const cells = LEAGUE_COLS.map((c) => {
        const v = r.metrics[c.key];
        const isBest = best[c.key] !== undefined && v === best[c.key];
        const cls = ["num", c.hvOnly ? "hv-only" : "", isBest ? "best" : ""].join(" ");
        return `<td class="${cls}">${fmt(v, c.digits)}${c.suffix || ""}${isBest ? '<span class="visually-hidden"> (best)</span>' : ""}</td>`;
      }).join("");
      return `<tr data-algo="${r.algo}" tabindex="0" aria-selected="${r.algo === state.selected}">
        <td>${ALGO_LABELS[r.algo]}</td>${cells}</tr>`;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => selectRun(tr.dataset.algo));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectRun(tr.dataset.algo);
      }
    });
  });
}

export function selectRun(algo) {
  if (!state.runs.some((r) => r.algo === algo)) return;
  state.selected = algo;
  document
    .querySelectorAll("#leagueTable tbody tr")
    .forEach((tr) => tr.setAttribute("aria-selected", tr.dataset.algo === algo));
  renderDetail();
  drawChart();
}

export function renderLegend() {
  const pids = [...new Set(state.runs.flatMap((r) => r.data.results.map((p) => p.pid)))];
  const segs = state.runs.flatMap((r) => r.data.segments);
  const has = (pid) => segs.some((s) => s.pid === pid);
  let html = pids
    .map((pid) => `<span class="legend-item"><i class="swatch" data-c="${colorFor(pid)}"></i>${esc(pid)}</span>`)
    .join("");
  html += `<span class="legend-item"><i class="swatch dep"></i>Departure (process done)</span>`;
  if (has("CS")) html += `<span class="legend-item"><i class="swatch cs"></i>Context switch / overhead</span>`;
  if (has("IDLE")) html += `<span class="legend-item"><i class="swatch idle"></i>Idle</span>`;
  if (has("MIGRATION")) html += `<span class="legend-item"><i class="swatch mig"></i>Migration</span>`;
  if (has("NUMA")) html += `<span class="legend-item"><i class="swatch numa"></i>NUMA hop</span>`;
  $("legend").innerHTML = html;
  paint($("legend"));
}

export function renderDetail() {
  const run = state.runs.find((r) => r.algo === state.selected);
  if (!run) return;

  const tabsEl = $("detailTabs");
  tabsEl.innerHTML = state.runs
    .map(
      (r) =>
        `<button type="button" role="tab" data-algo="${r.algo}" aria-selected="${r.algo === state.selected}" tabindex="${r.algo === state.selected ? 0 : -1}">${ALGO_LABELS[r.algo]}</button>`
    )
    .join("");
  tabsEl.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => selectRun(b.dataset.algo));
    b.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const list = state.runs.map((r) => r.algo);
      const i = list.indexOf(b.dataset.algo) + (e.key === "ArrowRight" ? 1 : -1);
      const next = list[(i + list.length) % list.length];
      selectRun(next);
      tabsEl.querySelector(`[data-algo="${next}"]`).focus();
    });
  });

  const tbody = document.querySelector("#resultTable tbody");
  tbody.innerHTML = run.data.results
    .map(
      (p) => `<tr data-pid="${esc(p.pid)}">
        <td><span class="pid"><i class="swatch" data-c="${colorFor(p.pid)}"></i>${esc(p.pid)}</span></td>
        <td>${p.vm === "Host" ? "Host" : `<span class="tag">${esc(p.vm)}</span>`}</td>
        <td class="num">${fmtTime(p.arrival)}</td>
        <td class="num">${fmtTime(p.burst)}</td>
        <td class="num">${fmtTime(p.completion)}</td>
        <td class="num">${fmtTime(p.turnaround)}</td>
        <td class="num">${fmtTime(p.waiting)}</td>
        <td class="num">${fmtTime(p.response)}</td>
        <td class="num">${esc(p.contextSwitches)}</td>
      </tr>`
    )
    .join("");
  paint(tbody);
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("mouseenter", () => setHover(tr.dataset.pid));
    tr.addEventListener("mouseleave", () => setHover(null));
  });

  renderHvDetail(run);
}

export function renderHvDetail(run) {
  const box = $("hvDetail");
  const d = run.data;
  if (!state.hv || !d.vmStats) {
    box.innerHTML = "";
    return;
  }
  const f = d.hypervisorFeatures || {};
  const features = [
    ["Live migration", f.migration],
    ["Memory overcommit", f.overcommit],
    ["I/O blocking", f.ioScheduling],
    ["CPU cache", f.caching],
    ["NUMA penalty", f.numa],
  ]
    .map(([label, on]) => `<li class="${on ? "on" : ""}">${label} ${on ? "on" : "off"}</li>`)
    .join("");

  let html = `<div class="hv-block">
    <h3>Virtual machines</h3>
    <ul class="feature-list" aria-label="Hypervisor features">${features}</ul>
    <div class="table-scroll"><table class="data">
      <thead><tr>
        <th scope="col">VM</th><th scope="col" class="num">CPU time</th><th scope="col">Utilisation</th>
        <th scope="col" class="num">Idle</th><th scope="col" class="num">Processes</th><th scope="col" class="num">Migrations</th>
        <th scope="col" class="num">NUMA node</th><th scope="col" class="num">NUMA hops</th><th scope="col" class="num">Overcommit</th><th scope="col" class="num">Cache hits</th>
      </tr></thead>
      <tbody>${d.vmStats
        .map((s) => {
          const lookups = (s.cacheHits || 0) + (s.cacheMisses || 0);
          const util = Math.min(100, s.utilization);
          return `<tr>
            <td><span class="tag">${esc(s.vm)}</span></td>
            <td class="num">${fmtTime(s.cpuTime)}</td>
            <td><span class="util"><span class="util-bar"><i data-w="${util}"></i></span>${fmt(s.utilization, 1)}%</span></td>
            <td class="num">${fmtTime(s.idleTime)}</td>
            <td class="num">${esc(s.processCount)}</td>
            <td class="num">${esc(s.migrations || 0)}</td>
            <td class="num">${esc(s.numaNode)}</td>
            <td class="num">${esc(s.numaHops || 0)}</td>
            <td class="num">${esc(s.overcommitEvents || 0)}</td>
            <td class="num">${lookups ? fmt((s.cacheHits / lookups) * 100, 1) + "%" : "–"}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table></div>
  </div>`;

  if (d.migrations && d.migrations.length) {
    html += `<div class="hv-block"><h3>Migrations</h3><div class="table-scroll"><table class="data">
      <thead><tr><th scope="col">Process</th><th scope="col">From</th><th scope="col">To</th><th scope="col" class="num">At</th><th scope="col" class="num">Penalty</th></tr></thead>
      <tbody>${d.migrations
        .map(
          (m) => `<tr><td>${esc(m.process)}</td><td><span class="tag">${esc(m.fromVM)}</span></td><td><span class="tag">${esc(m.toVM)}</span></td>
          <td class="num">${fmtTime(m.time)}</td><td class="num">${esc(m.penalty)}</td></tr>`
        )
        .join("")}</tbody></table></div></div>`;
  }

  if (d.cacheStats) {
    const c = d.cacheStats;
    html += `<div class="hv-block"><h3>CPU cache</h3>
      <p class="readout"><b>${esc(c.hits)}</b> hits, <b>${esc(c.misses)}</b> misses, hit rate <b>${fmt(c.hitRate, 1)}%</b>. Each miss adds 2 time units before the process runs.</p></div>`;
  }

  if (d.ioSchedule && d.ioSchedule.length) {
    html += `<div class="hv-block"><h3>I/O operations</h3>
      <p class="readout">A process blocks at each of its I/O points (halfway through the burst unless set). One device serves requests; when it frees up it takes the waiting request with the best priority number.</p>
      <div class="table-scroll"><table class="data">
      <thead><tr><th scope="col">Process</th><th scope="col">VM</th><th scope="col" class="num">Requested</th><th scope="col" class="num">Started</th><th scope="col" class="num">Waited</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Priority</th></tr></thead>
      <tbody>${d.ioSchedule
        .map(
          (io) => `<tr><td>${esc(io.pid)}</td><td><span class="tag">${esc(io.vm)}</span></td>
          <td class="num">${fmtTime(io.requestTime)}</td><td class="num">${fmtTime(io.startTime)}</td><td class="num">${fmtTime(io.startTime - io.requestTime)}</td>
          <td class="num">${esc(io.ioTime)}</td><td class="num">${esc(io.priority)}</td></tr>`
        )
        .join("")}</tbody></table></div></div>`;
  }

  box.innerHTML = html;
  paint(box);
}
