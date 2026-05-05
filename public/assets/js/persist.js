// Save, share and import workloads: URL hash, localStorage, JSON/CSV files and PNG export.
// Everything that comes in (hash, storage, file) goes through the engine's validation first.
import { validateVms } from "./engine/hypervisor.js";
import { validateProcesses } from "./engine/validate.js";
import { addPin, currentParams, renderPins } from "./pins.js";
import { runSimulation } from "./run.js";
import { $, resetColors, showNotification, state } from "./state.js";
import { renderVMOptions, workloadChanged } from "./workload.js";

const STORE_KEY = "cpusim:last";
const MAX_IMPORT = 256 * 1024;
const ALGOS = ["FCFS", "SJF", "SRTF", "PRIORITY", "PRIORITYP", "RR", "MLFQ"];
const VM_SCHEDULERS = ["RR", "PRIORITY", "PROPORTIONAL", "CREDIT", "LOTTERY"];
const HV_FEATURES = ["enableMigration", "enableOvercommit", "enableIOScheduling", "enableCaching", "enableNUMA"];
const num = (v, min, max, def) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : def);
const half = (v, def) => num(Math.round(v * 2) / 2, 0, 5, def);

function snapshot() {
  return {
    v: 1,
    processes: state.processes.map(({ pid, arrival, burst, priority, ioTime, ioAt, memReq, vm }) => ({ pid, arrival, burst, priority, ioTime, ioAt, memReq, vm })),
    vms: state.vms,
    pins: state.pins.map(({ base, params }) => ({ base, params })),
    settings: {
      algos: [...document.querySelectorAll("#algoChips input:checked")].map((i) => i.value),
      ...currentParams(),
      hv: $("hypervisorMode").checked,
      vmScheduler: $("vmScheduler").value,
      vmQuantum: +$("vmQuantum").value,
      migrationPenalty: +$("migrationPenalty").value,
      features: Object.fromEntries(HV_FEATURES.map((f) => [f, $(f).checked])),
    },
  };
}

// Throws Error with a readable message when the data is not a valid workload.
function apply(data) {
  const processes = validateProcesses(data?.processes);
  const vms = [...validateVms(data.vms ?? [], processes).values()].filter((v) => v.name !== "Host");
  resetColors();
  state.processes = processes;
  state.vms = vms;
  state.pins = [];
  for (const p of data.pins ?? []) {
    if (!ALGOS.includes(p?.base)) continue;
    const q = p.params ?? {};
    addPin(p.base, { quantum: num(q.quantum, 1, 1000, 2), aging: num(q.aging, 0, 1000, 0), mlfqBoost: num(q.mlfqBoost, 0, 10000, 0), csOverhead: half(q.csOverhead, 0) });
  }
  const s = data.settings;
  if (s) {
    document.querySelectorAll("#algoChips input").forEach((i) => (i.checked = (s.algos ?? []).includes(i.value)));
    $("quantum").value = num(s.quantum, 1, 1000, 2);
    $("priorityAging").value = num(s.aging, 0, 1000, 0);
    $("mlfqBoost").value = num(s.mlfqBoost, 0, 10000, 0);
    $("contextSwitchOverhead").value = half(s.csOverhead, 1);
    $("csOverheadValue").textContent = $("contextSwitchOverhead").value;
    $("hypervisorMode").checked = !!s.hv;
    $("hypervisorSettings").hidden = !s.hv;
    if (VM_SCHEDULERS.includes(s.vmScheduler)) $("vmScheduler").value = s.vmScheduler;
    $("vmQuantum").value = num(s.vmQuantum, 1, 1000, 10);
    $("migrationPenalty").value = num(s.migrationPenalty, 0, 100, 5);
    $("migrationValue").textContent = $("migrationPenalty").value;
    for (const f of HV_FEATURES) $(f).checked = !!s.features?.[f];
  }
  renderVMOptions();
  renderPins();
  workloadChanged();
}

/* ---- localStorage and URL ---- */

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot()));
    } catch {} // private mode or storage full: saving is a convenience only
  }, 300);
}
document.addEventListener("change", saveSoon);
document.addEventListener("cpusim:changed", saveSoon);

const toHash = (obj) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromHash = (text) => {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
};

// Called once at startup: a shared link wins over the last saved workload.
export function restore() {
  const hash = location.hash.match(/^#s=([A-Za-z0-9_-]{1,60000})$/);
  try {
    if (hash) {
      apply(fromHash(hash[1]));
      runSimulation();
      return;
    }
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) apply(JSON.parse(saved));
  } catch (e) {
    showNotification(hash ? `Couldn't open the shared link: ${e.message}` : "Ignored an unreadable saved workload.", "error");
  }
}

// Pasting a share link into a tab that already has the page open only changes the hash.
window.addEventListener("hashchange", () => location.hash.startsWith("#s=") && restore());

$("shareBtn").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#s=${toHash(snapshot())}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    showNotification("Link copied. It contains the whole workload and settings.", "success");
  } catch {
    showNotification("The link is now in the address bar; copy it from there.", "info");
  }
});

/* ---- Files ---- */

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("exportJsonBtn").addEventListener("click", () =>
  download("cpu-schedule.json", new Blob([JSON.stringify(snapshot(), null, 2)], { type: "application/json" }))
);

const CSV_HEAD = ["pid", "arrival", "burst", "priority", "ioTime", "ioAt", "memReq", "vm"];
$("exportCsvBtn").addEventListener("click", () => {
  const rows = state.processes.map((p) => [p.pid, p.arrival, p.burst, p.priority, p.ioTime, (p.ioAt ?? []).join(";"), p.memReq, p.vm].join(","));
  download("cpu-processes.csv", new Blob([[CSV_HEAD.join(","), ...rows].join("\n") + "\n"], { type: "text/csv" }));
});

// CSV carries the process table only; names cannot contain commas, so a plain split is enough.
function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/).map((l) => l.split(",").map((c) => c.trim()));
  const col = Object.fromEntries(head.map((h, i) => [h.toLowerCase(), i]));
  for (const need of ["pid", "arrival", "burst"]) if (!(need in col)) throw new Error(`CSV needs a "${need}" column`);
  return lines.filter((l) => l.some(Boolean)).map((l) => {
    const get = (k) => (k in col ? l[col[k]] : "");
    return { pid: get("pid"), arrival: get("arrival"), burst: get("burst"), priority: get("priority"), ioTime: get("iotime"), ioAt: get("ioat").replace(/;/g, ","), memReq: get("memreq"), vm: get("vm") };
  });
}

$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT) throw new Error("file is larger than 256 KB");
    const text = await file.text();
    if (/\.csv$/i.test(file.name)) {
      const processes = validateProcesses(parseCsv(text));
      const known = (vm) => vm === "Host" || state.vms.some((v) => v.name === vm);
      apply({ ...snapshot(), processes: processes.map((p) => (known(p.vm) ? p : { ...p, vm: "Host" })) });
    } else {
      apply(JSON.parse(text));
    }
    showNotification(`Imported ${file.name}.`, "success");
  } catch (err) {
    showNotification(`Couldn't import ${file.name}: ${err.message}`, "error");
  }
});

$("pngBtn").addEventListener("click", () => {
  const src = $("timetable");
  if (!state.runs.length) return showNotification("Run a timetable first.", "error");
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const c = out.getContext("2d");
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#fff";
  c.fillRect(0, 0, out.width, out.height);
  c.drawImage(src, 0, 0);
  out.toBlob((b) => b && download("timetable.png", b), "image/png");
});
