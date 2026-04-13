"use strict";

// Must match NAME_PATTERN / MAX_PROCESSES in src/bootstrap.php
const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
const MAX_PROCESSES = 100;

const PHP_BACKEND = {
  simulate: "api/simulate.php",
  hypervisor: "api/simulate_hypervisor.php",
};

const ALGO_LABELS = {
  FCFS: "FCFS",
  SJF: "SJF",
  SRTF: "SRTF",
  PRIORITY: "Priority",
  PRIORITYP: "Priority (P)",
  RR: "Round Robin",
  MLFQ: "MLFQ",
};

// Flat route colours, assigned by workload order so a process keeps its colour on every track.
const ROUTE_COLORS = [
  "#0055a4", "#d06f00", "#1b8a4b", "#7a3e9d", "#00838f", "#b5179e",
  "#5f7d00", "#3a5dae", "#a15c2f", "#b38600", "#4b6b88", "#c2185b",
];

// Non-process segments returned by the backend.
const SPECIAL = { IDLE: true, CS: true, MIGRATION: true, NUMA: true };

const state = {
  processes: [],
  vms: [],
  runs: [], // [{ algo, data, metrics }]
  hv: false,
  selected: null,
  clock: null,
  hoverPid: null,
  stale: false,
  hasRun: false,
  progress: 1,
  geom: null,
};

let processCounter = 1;
let autoProcessInterval = null;
let autoProcessCountdown = null;
let runSeq = 0;

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Escape anything interpolated into innerHTML (user input and server echoes of it).
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "–");
const fmtTime = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));
// Inline style="" attributes would force 'unsafe-inline' in the CSP, so colours and widths travel
// as data attributes and are applied through the style API after rendering.
function paint(root) {
  root.querySelectorAll("[data-c]").forEach((el) => (el.style.background = el.dataset.c));
  root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = `${el.dataset.w}%`));
}

const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;

function colorFor(pid) {
  const idx = state.processes.findIndex((p) => p.pid === pid);
  return ROUTE_COLORS[(idx === -1 ? hashIndex(pid) : idx) % ROUTE_COLORS.length];
}

function hashIndex(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/* ---------------- Toasts ---------------- */

function showNotification(message, type = "info") {
  const region = $("toasts");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(() => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 220);
  }, type === "error" ? 5000 : 2800);
}

/* ---------------- Workload tabs ---------------- */

const tabs = [$("tab-processes"), $("tab-vms")];
tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

function selectTab(active) {
  tabs.forEach((tab) => {
    const on = tab === active;
    tab.setAttribute("aria-selected", on);
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !on;
  });
}

/* ---------------- Workload: processes ---------------- */

$("processForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const pid = $("pid").value.trim();
  const arrival = parseInt($("arrival").value, 10);
  const burst = parseInt($("burst").value, 10);
  const priority = parseInt($("priority").value, 10) || 5;
  const ioTime = parseInt($("ioTime").value, 10) || 0;
  const memReq = parseInt($("memReq").value, 10) || 64;
  const vm = $("vmAssignment").value || "Host";
  const ioAt = [
    ...new Set(
      $("ioAt")
        .value.split(",")
        .map((t) => parseInt(t, 10))
        .filter((n) => Number.isInteger(n))
    ),
  ].sort((a, b) => a - b);

  if (!NAME_RE.test(pid)) {
    showNotification("Process ID must be 1-32 letters, digits, spaces, _ . -", "error");
    return;
  }
  if (isNaN(arrival) || isNaN(burst)) {
    showNotification("Enter an arrival time and a burst time.", "error");
    return;
  }
  if (state.processes.some((p) => p.pid === pid)) {
    showNotification(`Process ${pid} already exists.`, "error");
    return;
  }
  if (ioAt.some((n) => n < 1 || n >= burst)) {
    showNotification("I/O points must be between 1 and burst - 1 CPU units.", "error");
    return;
  }
  if (state.processes.length >= MAX_PROCESSES) {
    showNotification(`At most ${MAX_PROCESSES} processes are allowed.`, "error");
    return;
  }

  state.processes.push({ pid, arrival, burst, priority, ioTime, ioAt, memReq, vm });
  workloadChanged();
  e.target.reset();
  $("pid").focus();
});

$("processPreset").addEventListener("change", (e) => {
  const preset = PROCESS_PRESETS[e.target.value];
  e.target.value = "";
  if (!preset) return;
  state.processes = preset.map((p) => ({ ...p, vm: "Host" }));
  workloadChanged();
  showNotification("Preset workload loaded.", "success");
});

$("clearProcessesBtn").addEventListener("click", () => {
  if (!state.processes.length || !confirm("Remove every process from the workload?")) return;
  state.processes = [];
  processCounter = 1;
  workloadChanged();
});

function removeProcess(pid) {
  state.processes = state.processes.filter((p) => p.pid !== pid);
  workloadChanged();
}

function renderProcessTable() {
  const tbody = document.querySelector("#processTable tbody");
  $("processCount").textContent = state.processes.length;
  if (!state.processes.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No processes yet. Add one above or load a preset.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.processes
    .map(
      (p) => `<tr>
        <td><span class="pid"><i class="swatch" data-c="${colorFor(p.pid)}"></i>${esc(p.pid)}</span></td>
        <td class="num">${esc(p.arrival)}</td>
        <td class="num">${esc(p.burst)}</td>
        <td class="num">${esc(p.priority)}</td>
        <td class="num">${esc(p.ioTime)}${p.ioTime && p.ioAt?.length ? `<span class="hint"> @${esc(p.ioAt.join(","))}</span>` : ""}</td>
        <td class="num">${esc(p.memReq)}</td>
        <td>${p.vm === "Host" ? "Host" : `<span class="tag">${esc(p.vm)}</span>`}</td>
        <td><button type="button" class="icon-btn" data-pid="${esc(p.pid)}" aria-label="Remove ${esc(p.pid)}">${icon("i-x")}</button></td>
      </tr>`
    )
    .join("");
  paint(tbody);
  tbody.querySelectorAll(".icon-btn").forEach((btn) =>
    btn.addEventListener("click", () => removeProcess(btn.dataset.pid))
  );
}

/* ---------------- Workload: VMs ---------------- */

$("vmForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("vmName").value.trim();
  if (!NAME_RE.test(name) || name === "Host") {
    showNotification('VM name must be 1-32 letters, digits, spaces, _ . - and not "Host".', "error");
    return;
  }
  if (state.vms.some((v) => v.name === name)) {
    showNotification(`VM ${name} already exists.`, "error");
    return;
  }
  state.vms.push({
    name,
    priority: parseInt($("vmPriority").value, 10) || 5,
    cpuShare: parseInt($("vmCPUShare").value, 10) || 25,
    memory: parseInt($("vmMemory").value, 10) || 512,
    type: $("vmType").value,
  });
  vmsChanged();
  e.target.reset();
  $("vmName").focus();
});

$("vmPreset").addEventListener("change", (e) => {
  const preset = VM_PRESETS[e.target.value];
  e.target.value = "";
  if (!preset) return;
  state.vms = preset.map((v) => ({ ...v }));
  // Spread processes across the new VMs so hypervisor mode has something to schedule.
  state.processes.forEach((p, i) => (p.vm = state.vms[i % state.vms.length].name));
  vmsChanged();
  showNotification("Preset VMs loaded and processes spread across them.", "success");
});

$("clearVMsBtn").addEventListener("click", () => {
  if (!state.vms.length || !confirm("Remove every VM? Their processes move to the host.")) return;
  state.vms = [];
  state.processes.forEach((p) => (p.vm = "Host"));
  vmsChanged();
});

function removeVM(name) {
  state.vms = state.vms.filter((v) => v.name !== name);
  state.processes.forEach((p) => {
    if (p.vm === name) p.vm = "Host";
  });
  vmsChanged();
}

function vmsChanged() {
  renderVMOptions();
  workloadChanged();
}

function renderVMTable() {
  const tbody = document.querySelector("#vmTable tbody");
  $("vmCount").textContent = state.vms.length;
  if (!state.vms.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No VMs yet. Add one above or load a preset.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.vms
    .map((vm) => {
      const count = state.processes.filter((p) => p.vm === vm.name).length;
      return `<tr>
        <td><span class="tag">${esc(vm.name)}</span></td>
        <td>${esc(vm.type)}</td>
        <td class="num">${esc(vm.priority)}</td>
        <td class="num">${esc(vm.cpuShare)}%</td>
        <td class="num">${esc(vm.memory)}</td>
        <td class="num">${count}</td>
        <td><button type="button" class="icon-btn" data-vm="${esc(vm.name)}" aria-label="Remove ${esc(vm.name)}">${icon("i-x")}</button></td>
      </tr>`;
    })
    .join("");
  tbody.querySelectorAll(".icon-btn").forEach((btn) =>
    btn.addEventListener("click", () => removeVM(btn.dataset.vm))
  );
}

function renderVMOptions() {
  const select = $("vmAssignment");
  const current = select.value;
  select.replaceChildren(new Option("Host", ""));
  state.vms.forEach((vm) => select.add(new Option(`${vm.name} (${vm.type})`, vm.name)));
  select.value = state.vms.some((v) => v.name === current) ? current : "";
}

/* ---------------- Auto-generation ---------------- */

$("autoProcessToggle").addEventListener("change", (e) => {
  e.target.checked ? startAutoProcessGeneration() : stopAutoProcessGeneration();
});

function startAutoProcessGeneration() {
  $("autoProcessStatus").hidden = false;
  let countdown = 5;
  $("countdown").textContent = countdown;
  autoProcessCountdown = setInterval(() => {
    countdown = countdown <= 1 ? 5 : countdown - 1;
    $("countdown").textContent = countdown;
  }, 1000);
  autoProcessInterval = setInterval(generateRandomProcess, 5000);
}

function stopAutoProcessGeneration() {
  clearInterval(autoProcessInterval);
  clearInterval(autoProcessCountdown);
  autoProcessInterval = autoProcessCountdown = null;
  $("autoProcessStatus").hidden = true;
  $("autoProcessToggle").checked = false;
}

function generateRandomProcess() {
  if (state.processes.length >= MAX_PROCESSES) {
    stopAutoProcessGeneration();
    showNotification(`Process limit (${MAX_PROCESSES}) reached; auto-add stopped.`, "error");
    return;
  }
  let pid;
  do {
    pid = `AUTO_P${processCounter++}`;
  } while (state.processes.some((p) => p.pid === pid));

  const lastArrival = state.processes.reduce((m, p) => Math.max(m, p.arrival), -1);
  const vm = state.vms.length ? state.vms[Math.floor(Math.random() * state.vms.length)].name : "Host";
  state.processes.push({
    pid,
    arrival: lastArrival < 0 ? 0 : lastArrival + 1 + Math.floor(Math.random() * 3),
    burst: 3 + Math.floor(Math.random() * 10),
    priority: 1 + Math.floor(Math.random() * 10),
    ioTime: Math.random() > 0.5 ? Math.floor(Math.random() * 4) : 0,
    memReq: [64, 128, 256, 512][Math.floor(Math.random() * 4)],
    vm,
  });
  workloadChanged();
  showNotification(`Added ${pid} on ${vm}.`, "info");
}

/* ---------------- Settings ---------------- */

$("hypervisorMode").addEventListener("change", (e) => {
  $("hypervisorSettings").hidden = !e.target.checked;
  settingsChanged();
});

$("contextSwitchOverhead").addEventListener("input", (e) => {
  $("csOverheadValue").textContent = e.target.value;
});
$("migrationPenalty").addEventListener("input", (e) => {
  $("migrationValue").textContent = e.target.value;
});

document
  .querySelectorAll(
    "#algoChips input, #quantum, #priorityAging, #mlfqBoost, #contextSwitchOverhead, #vmScheduler, #vmQuantum, #migrationPenalty, .features input"
  )
  .forEach((el) => el.addEventListener("change", settingsChanged));

// Once a timetable exists, every setting change re-runs all selected algorithms.
let settingsTimer = null;
function settingsChanged() {
  if (!state.hasRun || state.stale) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(runSimulation, 250);
}

function workloadChanged() {
  renderProcessTable();
  renderVMTable();
  if (state.hasRun && !state.stale) {
    state.stale = true;
    $("chartWrap").classList.add("is-stale");
    $("staleBanner").hidden = false;
  }
}

/* ---------------- Running ---------------- */

$("runBtn").addEventListener("click", runSimulation);

function selectedAlgorithms() {
  return [...document.querySelectorAll("#algoChips input:checked")].map((i) => i.value);
}

function buildPayload(algo, hv) {
  const processes = state.processes.map(({ pid, arrival, burst, priority, ioTime, ioAt, memReq, vm }) => ({
    pid, arrival, burst, priority, ioTime, ioAt, memReq, vm,
  }));
  const quantum = parseInt($("quantum").value, 10) || 2;
  const csOverhead = parseFloat($("contextSwitchOverhead").value) || 0;
  const aging = parseInt($("priorityAging").value, 10) || 0;
  const mlfqBoost = parseInt($("mlfqBoost").value, 10) || 0;
  if (!hv) return { algorithm: algo, quantum, aging, mlfqBoost, processes, csOverhead };
  return {
    processAlgo: algo,
    processQuantum: quantum,
    mlfqBoost,
    processes,
    vms: state.vms,
    vmScheduler: $("vmScheduler").value,
    vmQuantum: parseInt($("vmQuantum").value, 10) || 10,
    enableMigration: $("enableMigration").checked,
    enableOvercommit: $("enableOvercommit").checked,
    enableIOScheduling: $("enableIOScheduling").checked,
    enableCaching: $("enableCaching").checked,
    enableNUMA: $("enableNUMA").checked,
    csOverhead,
    migrationPenalty: parseInt($("migrationPenalty").value, 10) || 0,
  };
}

async function post(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Can't reach ${url}. Serve this folder with PHP (php -S localhost:8000 -t public).`);
  }
  const data = await response.json().catch(() => ({}));
  if (data.error) throw new Error(data.error);
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return data;
}

async function runSimulation() {
  const algos = selectedAlgorithms();
  const quantum = parseInt($("quantum").value, 10);
  if (!state.processes.length) {
    showNotification("Add at least one process, or load a preset.", "error");
    return;
  }
  if (!algos.length) {
    showNotification("Pick at least one algorithm to compare.", "error");
    return;
  }
  if (algos.some((a) => a === "RR" || a === "MLFQ") && !(quantum >= 1)) {
    showNotification("Round Robin and MLFQ need a quantum of at least 1.", "error");
    return;
  }

  const wantsHv = $("hypervisorMode").checked;
  const hv = wantsHv && state.vms.length > 0;
  if (wantsHv && !hv) showNotification("No VMs defined, so this run skips the hypervisor layer.", "info");

  const seq = ++runSeq;
  const btn = $("runBtn");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");

  const settled = await Promise.allSettled(
    algos.map((algo) => post(hv ? PHP_BACKEND.hypervisor : PHP_BACKEND.simulate, buildPayload(algo, hv)))
  );
  if (seq !== runSeq) return; // a newer run superseded this one
  btn.disabled = false;
  btn.removeAttribute("aria-busy");

  const failed = settled.find((r) => r.status === "rejected");
  if (failed) showNotification(failed.reason.message, "error");

  const runs = settled
    .map((r, i) => (r.status === "fulfilled" ? { algo: algos[i], data: r.value, metrics: metricsOf(r.value) } : null))
    .filter(Boolean);
  if (!runs.length) return;

  state.runs = runs;
  state.hv = hv;
  state.hasRun = true;
  state.stale = false;
  state.hoverPid = null;
  if (!runs.some((r) => r.algo === state.selected)) state.selected = runs[0].algo;
  if (state.clock !== null && state.clock > timelineEnd()) state.clock = null;

  $("chartWrap").classList.remove("is-stale");
  $("staleBanner").hidden = true;
  document.body.classList.toggle("is-hv", hv);

  renderResults();
  revealChart();
}

function metricsOf(data) {
  const rows = data.results;
  const n = rows.length || 1;
  const sum = (key) => rows.reduce((s, p) => s + p[key], 0);
  const makespan = rows.reduce((m, p) => Math.max(m, p.completion), 0) || 1;
  return {
    turnaround: sum("turnaround") / n,
    waiting: sum("waiting") / n,
    response: sum("response") / n,
    throughput: rows.length / makespan,
    busy: (sum("burst") / makespan) * 100,
    switches: data.contextSwitches || 0,
    migrations: data.totalMigrations || 0,
  };
}

function timelineEnd() {
  return (
    state.runs.reduce((m, r) => r.data.segments.reduce((mm, s) => Math.max(mm, s.end), m), 0) || 1
  );
}

/* ---------------- Results ---------------- */

function renderResults() {
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

const LEAGUE_COLS = [
  { key: "turnaround", better: "min", digits: 2 },
  { key: "waiting", better: "min", digits: 2 },
  { key: "response", better: "min", digits: 2 },
  { key: "throughput", better: "max", digits: 3 },
  { key: "busy", better: "max", digits: 1, suffix: "%" },
  { key: "switches", better: "min", digits: 0 },
  { key: "migrations", better: null, digits: 0, hvOnly: true },
];

function renderLeague() {
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

function selectRun(algo) {
  if (!state.runs.some((r) => r.algo === algo)) return;
  state.selected = algo;
  document
    .querySelectorAll("#leagueTable tbody tr")
    .forEach((tr) => tr.setAttribute("aria-selected", tr.dataset.algo === algo));
  renderDetail();
  drawChart();
}

function renderLegend() {
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

function renderDetail() {
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

function renderHvDetail(run) {
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

/* ---------------- Timetable chart ---------------- */

const canvas = $("timetable");
const ctx = canvas.getContext("2d");
const G = { left: 132, right: 28, axis: 34, arrivals: 34, track: 54, bottom: 14, bar: 26 };
const COND = `"Barlow Semi Condensed", Barlow, sans-serif`;

function niceStep(span, maxTicks) {
  const raw = span / Math.max(1, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(raw));
  return Math.max([1, 2, 5, 10].find((m) => m * pow >= raw) * pow, 1);
}

function segmentAt(run, t) {
  return run.data.segments.find((s) => s.start <= t && t < s.end) || null;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const runs = state.runs;
  const wrap = $("chartWrap");
  if (!runs.length) {
    canvas.style.height = "0px";
    state.geom = null;
    return;
  }

  const ink = cssVar("--ink");
  const ink2 = cssVar("--ink-2");
  const ink3 = cssVar("--ink-3");
  const rule = cssVar("--rule");
  const ruleStrong = cssVar("--rule-strong");
  const blue = cssVar("--blue");
  const blueWash = cssVar("--blue-wash");
  const signal = cssVar("--signal");

  const W = wrap.clientWidth;
  const left = W < 520 ? 92 : G.left;
  const H = G.axis + G.arrivals + runs.length * G.track + G.bottom;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = `${H}px`;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const end = timelineEnd();
  const plotW = Math.max(40, W - left - G.right);
  const x = (t) => left + (t / end) * plotW;
  const tracksTop = G.axis + G.arrivals;
  state.geom = { left, plotW, end, top: tracksTop };

  // Selected track band
  runs.forEach((r, i) => {
    if (r.algo !== state.selected) return;
    ctx.fillStyle = blueWash;
    ctx.fillRect(0, tracksTop + i * G.track, W, G.track);
  });

  // Clock grid: every tick ruled, every fifth heavier, like timetable hour columns
  const step = niceStep(end, plotW / 64);
  ctx.font = `600 12px ${COND}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let t = 0, k = 0; t <= end + 1e-9; t += step, k++) {
    const gx = Math.round(x(t)) + 0.5;
    ctx.strokeStyle = k % 5 === 0 ? ruleStrong : rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, G.axis - 6);
    ctx.lineTo(gx, H - G.bottom);
    ctx.stroke();
    ctx.fillStyle = k % 5 === 0 ? ink : ink3;
    ctx.fillText(fmtTime(t), gx, G.axis / 2);
  }

  // Arrivals row: a departure marker per process at its arrival time
  ctx.fillStyle = ink2;
  ctx.textAlign = "left";
  ctx.font = `600 11px ${COND}`;
  ctx.fillText("ARRIVALS", 12, G.axis + G.arrivals / 2);
  let lastLabelEnd = -Infinity;
  runs[0].data.results
    .slice()
    .sort((a, b) => a.arrival - b.arrival)
    .forEach((p) => {
      const ax = x(p.arrival);
      ctx.globalAlpha = state.hoverPid && state.hoverPid !== p.pid ? 0.25 : 1;
      ctx.fillStyle = colorFor(p.pid);
      ctx.beginPath();
      ctx.moveTo(ax - 5, G.axis + 8);
      ctx.lineTo(ax + 5, G.axis + 8);
      ctx.lineTo(ax, G.axis + 16);
      ctx.closePath();
      ctx.fill();
      const label = String(p.pid);
      const w = ctx.measureText(label).width;
      if (ax - w / 2 > lastLabelEnd + 4 && ax - w / 2 > left - 8) {
        ctx.fillStyle = ink2;
        ctx.textAlign = "center";
        ctx.fillText(label, ax, G.axis + 26);
        lastLabelEnd = ax + w / 2;
      }
      ctx.globalAlpha = 1;
    });

  // Tracks
  const reveal = left + state.progress * plotW;
  runs.forEach((r, i) => {
    const y0 = tracksTop + i * G.track;
    const mid = y0 + G.track / 2;
    const selected = r.algo === state.selected;

    ctx.textAlign = "left";
    ctx.fillStyle = selected ? blue : ink;
    ctx.font = `700 15px ${COND}`;
    ctx.fillText(left < G.left ? r.algo : ALGO_LABELS[r.algo], 12, mid - 8);
    ctx.fillStyle = ink3;
    ctx.font = `500 12px Barlow, sans-serif`;
    ctx.fillText(`wait ${fmt(r.metrics.waiting)}`, 12, mid + 9);

    // The rail, visible wherever the CPU idles
    ctx.strokeStyle = ruleStrong;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, mid);
    ctx.lineTo(left + plotW, mid);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 1, y0, Math.max(0, reveal - left + 1), G.track);
    ctx.clip();

    const top = mid - G.bar / 2;
    ctx.font = `700 12px ${COND}`;
    r.data.segments.forEach((s) => {
      if (s.pid === "IDLE") return;
      const sx = x(s.start);
      const sw = Math.max(1, x(s.end) - sx);
      if (SPECIAL[s.pid]) {
        hatch(sx, top + 4, sw, G.bar - 8, { CS: "#8a929e", MIGRATION: signal, NUMA: "#8a5400" }[s.pid]);
        return;
      }
      ctx.globalAlpha = state.hoverPid && state.hoverPid !== s.pid ? 0.18 : 1;
      ctx.fillStyle = colorFor(s.pid);
      ctx.fillRect(sx, top, sw, G.bar);
      ctx.fillStyle = "#fff";
      ctx.fillRect(sx + sw - 1, top, 1, G.bar); // hairline between consecutive trains
      const label = String(s.pid);
      if (ctx.measureText(label).width + 8 < sw) {
        ctx.textAlign = "center";
        ctx.fillText(label, sx + sw / 2, mid + 0.5);
      }
      ctx.globalAlpha = 1;
    });

    // Departure ticks: where each train finishes its run on this track
    r.data.results.forEach((p) => {
      const dx = Math.round(x(p.completion)) - 1;
      ctx.globalAlpha = state.hoverPid && state.hoverPid !== p.pid ? 0.18 : 1;
      ctx.fillStyle = colorFor(p.pid);
      ctx.fillRect(dx, top - 6, 3, G.bar + 12);
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    ctx.strokeStyle = rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y0 + G.track - 0.5);
    ctx.lineTo(W, y0 + G.track - 0.5);
    ctx.stroke();
  });

  // The clock hand: one red line through every track
  if (state.clock !== null) {
    const cx = Math.round(x(state.clock)) + 0.5;
    ctx.strokeStyle = signal;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, G.axis);
    ctx.lineTo(cx, H - G.bottom + 4);
    ctx.stroke();
    const label = `t ${fmtTime(state.clock)}`;
    ctx.font = `700 12px ${COND}`;
    const lw = ctx.measureText(label).width + 12;
    const lx = Math.min(Math.max(cx - lw / 2, left - 4), W - lw - 2);
    ctx.fillStyle = signal;
    roundRect(lx, 4, lw, G.axis - 10, 3);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, lx + lw / 2, 4 + (G.axis - 10) / 2 + 0.5);
  }

  canvas.setAttribute(
    "aria-label",
    `Timetable of ${runs.length} algorithm${runs.length === 1 ? "" : "s"} over ${fmtTime(end)} time units. ` +
      runs.map((r) => `${ALGO_LABELS[r.algo]}: average waiting ${fmt(r.metrics.waiting)}`).join("; ")
  );
}

function hatch(x0, y0, w, h, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.fillStyle = "#eef0f3";
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let k = x0 - h; k < x0 + w; k += 5) {
    ctx.moveTo(k, y0 + h);
    ctx.lineTo(k + h, y0);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(x0, y0, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + w, y0, r);
  ctx.closePath();
}

// The one authored motion: trains run in along every track at once, left to right.
function revealChart() {
  if (!window.gsap || reduceMotion.matches) {
    state.progress = 1;
    drawChart();
    return;
  }
  gsap.killTweensOf(state);
  state.progress = 0;
  gsap.to(state, { progress: 1, duration: 0.7, ease: "expo.out", onUpdate: drawChart });
}

function timeAt(e) {
  const g = state.geom;
  return ((e.clientX - canvas.getBoundingClientRect().left - g.left) / g.plotW) * g.end;
}

function runAt(e) {
  const g = state.geom;
  const i = Math.floor((e.clientY - canvas.getBoundingClientRect().top - g.top) / G.track);
  return i >= 0 && i < state.runs.length ? state.runs[i] : null;
}

const snapTime = (t) => Math.min(state.geom.end, Math.max(0, Math.round(t * 2) / 2));

let dragging = false;

canvas.addEventListener("pointerdown", (e) => {
  if (!state.geom) return;
  if (e.clientX - canvas.getBoundingClientRect().left < state.geom.left) {
    const run = runAt(e);
    if (run) selectRun(run.algo);
    return;
  }
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
  setClock(snapTime(timeAt(e)));
});

canvas.addEventListener("pointermove", (e) => {
  if (!state.geom) return;
  if (dragging) {
    setClock(snapTime(timeAt(e)));
    return;
  }
  const run = runAt(e);
  const seg = run ? segmentAt(run, timeAt(e)) : null;
  const hit = seg && !SPECIAL[seg.pid];
  setHover(hit ? seg.pid : null, hit ? { run, seg } : null);
});

canvas.addEventListener("pointerup", () => (dragging = false));
canvas.addEventListener("pointercancel", () => (dragging = false));
canvas.addEventListener("pointerleave", () => {
  if (!dragging) setHover(null);
});

canvas.addEventListener("keydown", (e) => {
  if (!state.geom) return;
  const by = e.shiftKey ? 10 : 1;
  const now = state.clock ?? 0;
  const next = {
    ArrowRight: now + by,
    ArrowLeft: now - by,
    Home: 0,
    End: state.geom.end,
    Escape: null,
  }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setClock(next === null ? null : Math.min(state.geom.end, Math.max(0, next)));
});

function setClock(t) {
  state.clock = t;
  renderReadout();
  renderStep();
  drawChart();
}

function setHover(pid, info = null) {
  if (state.hoverPid === pid && !info) return;
  state.hoverPid = pid;
  canvas.style.cursor = pid ? "pointer" : "crosshair";
  renderReadout(info);
  drawChart();
}

function renderReadout(info = null) {
  const el = $("clockReadout");
  if (!state.runs.length) {
    el.textContent = "Add processes, pick algorithms, then run.";
    return;
  }
  if (info) {
    const r = info.run.data.results.find((p) => p.pid === info.seg.pid);
    el.innerHTML =
      `<b>${esc(info.seg.pid)}</b> on ${ALGO_LABELS[info.run.algo]}: runs ${fmtTime(info.seg.start)}–${fmtTime(info.seg.end)}` +
      (r ? `, arrived ${fmtTime(r.arrival)}, done at ${fmtTime(r.completion)}, waited ${fmtTime(r.waiting)}` : "");
    return;
  }
  if (state.clock === null) {
    el.textContent = "Click or drag on the chart to read every track at one moment.";
    return;
  }
  const t = state.clock;
  const parts = state.runs.map((r) => {
    const s = segmentAt(r, t);
    const what =
      !s || s.pid === "IDLE" ? "idle" : s.pid === "CS" ? "switching" : s.pid === "MIGRATION" ? "migrating" : `<b>${esc(s.pid)}</b>`;
    return `${ALGO_LABELS[r.algo]} ${what}`;
  });
  el.innerHTML = `<span class="now">t = ${fmtTime(t)}</span> · ${parts.join(" · ")}`;
}

/* ---------------- Step-through ---------------- */

const listOf = (items) => items.map(esc).join(", ");

// Plain-English reason for one dispatch from the backend's decision log.
function reasonText(algo, d) {
  const among = d.ready.map((r) => `${r.pid} (${fmtTime(r.value)})`).join(", ");
  const only = d.ready.length === 1;
  const who = `${ALGO_LABELS[algo]} picks <b>${esc(d.pid)}</b>`;
  if (only) return `${who}: the only process ready.`;
  switch (d.reason) {
    case "first_arrived": return `${who}: arrived first among ${esc(among)}.`;
    case "shortest_burst": return `${who}: shortest burst among ${esc(among)}.`;
    case "least_remaining": return `${who}: least time remaining among ${esc(among)}.`;
    case "best_priority": return `${who}: best priority number (lowest wins) among ${esc(among)}.`;
    case "queue_front": {
      const lvl = d.ready.find((r) => r.pid === d.pid)?.value;
      return `${who}: front of ${algo === "MLFQ" ? `the highest busy queue (level ${lvl})` : "the queue"}; waiting: ${listOf(d.ready.filter((r) => r.pid !== d.pid).map((r) => r.pid))}.`;
    }
  }
  return `${who}.`;
}

// Processes that have arrived by t, are unfinished, and are not on the CPU.
function readyAt(run, t) {
  const on = segmentAt(run, t)?.pid;
  return run.data.results.filter((p) => p.arrival <= t && p.completion > t && p.pid !== on).map((p) => p.pid);
}

function renderStep() {
  const box = $("stepper");
  box.hidden = !state.runs.length;
  if (box.hidden) return;
  const t = state.clock;
  $("stepPanel").innerHTML =
    t === null
      ? `<p class="step-hint">Press Play or Step to walk through the schedule one decision at a time.</p>`
      : state.runs
          .map((run) => {
            const d = run.data.decisions?.filter((x) => x.time <= t).pop();
            const ready = readyAt(run, t);
            return (
              `<div class="step-row"><h4>${ALGO_LABELS[run.algo]}</h4>` +
              `<p>${d ? reasonText(run.algo, d) + ` <span class="step-at">(decided at t ${fmtTime(d.time)})</span>` : "No dispatch yet."}</p>` +
              `<p class="step-queue">Ready at t ${fmtTime(t)}: ${ready.length ? listOf(ready) : "nobody waiting"}</p></div>`
            );
          })
          .join("");
}

// Step jumps to the next (or previous) moment any track made a dispatch decision.
function stepClock(dir) {
  const times = [...new Set(state.runs.flatMap((r) => (r.data.decisions || []).map((d) => d.time)))].sort((a, b) => a - b);
  const now = state.clock ?? -1;
  const next = dir > 0 ? times.find((x) => x > now) : times.filter((x) => x < now).pop();
  if (next === undefined) {
    if (dir > 0) stopPlay();
    return;
  }
  setClock(next);
}

let playTimer = null;
function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $("stepPlay").setAttribute("aria-pressed", "false");
  $("stepPlay").innerHTML = `${icon("i-play")}<span>Play</span>`;
}
$("stepPlay").addEventListener("click", () => {
  if (playTimer) return stopPlay();
  if (state.clock === null || state.clock >= state.geom?.end) setClock(0);
  $("stepPlay").setAttribute("aria-pressed", "true");
  $("stepPlay").innerHTML = `${icon("i-pause")}<span>Pause</span>`;
  playTimer = setInterval(() => {
    if (state.clock >= state.geom.end) return stopPlay();
    setClock(Math.min(state.geom.end, state.clock + 0.5));
  }, 120);
});
$("stepNext").addEventListener("click", () => { stopPlay(); stepClock(1); });
$("stepBack").addEventListener("click", () => { stopPlay(); stepClock(-1); });

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 120);
});

/* ---------------- Smooth scrolling ---------------- */

if (window.Lenis && window.gsap && !reduceMotion.matches) {
  const lenis = new Lenis({ lerp: 0.14 });
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ---------------- Presets ---------------- */

const PROCESS_PRESETS = {
  sample: [
    { pid: "P1", arrival: 0, burst: 5, priority: 2, ioTime: 1, memReq: 128 },
    { pid: "P2", arrival: 1, burst: 3, priority: 1, ioTime: 0, memReq: 64 },
    { pid: "P3", arrival: 2, burst: 8, priority: 3, ioTime: 2, memReq: 256 },
    { pid: "P4", arrival: 3, burst: 6, priority: 2, ioTime: 1, memReq: 128 },
  ],
  io: [
    { pid: "IO1", arrival: 0, burst: 4, priority: 3, ioTime: 3, memReq: 64 },
    { pid: "IO2", arrival: 1, burst: 3, priority: 4, ioTime: 4, memReq: 128 },
    { pid: "IO3", arrival: 2, burst: 5, priority: 3, ioTime: 3, memReq: 64 },
    { pid: "IO4", arrival: 3, burst: 2, priority: 5, ioTime: 5, memReq: 128 },
  ],
  cpu: [
    { pid: "CPU1", arrival: 0, burst: 10, priority: 1, ioTime: 0, memReq: 512 },
    { pid: "CPU2", arrival: 1, burst: 15, priority: 2, ioTime: 1, memReq: 256 },
    { pid: "CPU3", arrival: 2, burst: 12, priority: 1, ioTime: 0, memReq: 1024 },
    { pid: "CPU4", arrival: 3, burst: 8, priority: 3, ioTime: 1, memReq: 256 },
  ],
};

const VM_PRESETS = {
  sample: [
    { name: "VM1", priority: 2, cpuShare: 40, memory: 1024, type: "compute" },
    { name: "VM2", priority: 5, cpuShare: 30, memory: 512, type: "standard" },
    { name: "VM3", priority: 8, cpuShare: 30, memory: 2048, type: "memory" },
  ],
  balanced: [
    { name: "Web-VM", priority: 3, cpuShare: 25, memory: 512, type: "standard" },
    { name: "DB-VM", priority: 1, cpuShare: 35, memory: 2048, type: "memory" },
    { name: "App-VM", priority: 2, cpuShare: 25, memory: 1024, type: "compute" },
    { name: "Cache-VM", priority: 4, cpuShare: 15, memory: 512, type: "realtime" },
  ],
};

/* ---------------- Init ---------------- */

renderProcessTable();
renderVMTable();
renderVMOptions();
renderResults();
document.fonts?.ready.then(drawChart);
