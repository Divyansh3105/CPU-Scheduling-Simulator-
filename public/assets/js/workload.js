import { PROCESS_PRESETS, VM_PRESETS } from "./presets.js";
import { runSimulation } from "./run.js";
import { $, MAX_PROCESSES, NAME_RE, colorFor, esc, icon, paint, resetColors, showNotification, state } from "./state.js";

let processCounter = 1;
let autoProcessInterval = null;
let autoProcessCountdown = null;

/* ---------------- Workload tabs ---------------- */

export const tabs = [$("tab-processes"), $("tab-vms")];
tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

export function selectTab(active) {
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
  resetColors();
  state.processes = preset.map((p) => ({ ...p, vm: "Host" }));
  workloadChanged();
  showNotification("Preset workload loaded.", "success");
});

$("clearProcessesBtn").addEventListener("click", () => {
  if (!state.processes.length || !confirm("Remove every process from the workload?")) return;
  resetColors();
  state.processes = [];
  processCounter = 1;
  workloadChanged();
});

export function removeProcess(pid) {
  state.processes = state.processes.filter((p) => p.pid !== pid);
  workloadChanged();
}

export function renderProcessTable() {
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

export function removeVM(name) {
  state.vms = state.vms.filter((v) => v.name !== name);
  state.processes.forEach((p) => {
    if (p.vm === name) p.vm = "Host";
  });
  vmsChanged();
}

export function vmsChanged() {
  renderVMOptions();
  workloadChanged();
}

export function renderVMTable() {
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

export function renderVMOptions() {
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

export function startAutoProcessGeneration() {
  $("autoProcessStatus").hidden = false;
  let countdown = 5;
  $("countdown").textContent = countdown;
  autoProcessCountdown = setInterval(() => {
    countdown = countdown <= 1 ? 5 : countdown - 1;
    $("countdown").textContent = countdown;
  }, 1000);
  autoProcessInterval = setInterval(generateRandomProcess, 5000);
}

export function stopAutoProcessGeneration() {
  clearInterval(autoProcessInterval);
  clearInterval(autoProcessCountdown);
  autoProcessInterval = autoProcessCountdown = null;
  $("autoProcessStatus").hidden = true;
  $("autoProcessToggle").checked = false;
}

export function generateRandomProcess() {
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
export let settingsTimer = null;
export function settingsChanged() {
  if (!state.hasRun || state.stale) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(runSimulation, 250);
}

export function workloadChanged() {
  renderProcessTable();
  renderVMTable();
  if (state.hasRun && !state.stale) {
    state.stale = true;
    $("chartWrap").classList.add("is-stale");
    $("staleBanner").hidden = false;
  }
}
