import { runSchedule } from "./api.js";
import { revealChart } from "./chart.js";
import { renderResults } from "./results.js";
import { $, showNotification, state } from "./state.js";

let runSeq = 0;

/* ---------------- Running ---------------- */

$("runBtn").addEventListener("click", runSimulation);

export function selectedAlgorithms() {
  return [...document.querySelectorAll("#algoChips input:checked")].map((i) => i.value);
}

export function buildPayload(algo, hv) {
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

export async function runSimulation() {
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
    algos.map((algo) => Promise.resolve().then(() => runSchedule(hv, buildPayload(algo, hv))))
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

export function metricsOf(data) {
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

// Memoised per run set: it is read on every redraw.
let endOf = null;
let endValue = 1;
export function timelineEnd() {
  if (endOf !== state.runs) {
    endOf = state.runs;
    endValue = state.runs.reduce((m, r) => Math.max(m, r.data.segments.at(-1)?.end ?? 0), 0) || 1;
  }
  return endValue;
}
