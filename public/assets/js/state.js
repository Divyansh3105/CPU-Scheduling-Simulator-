// Must match NAME_PATTERN / MAX_PROCESSES in src/bootstrap.php
export const NAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;
export const MAX_PROCESSES = 100;


export const ALGO_LABELS = {
  FCFS: "FCFS",
  SJF: "SJF",
  SRTF: "SRTF",
  PRIORITY: "Priority",
  PRIORITYP: "Priority (P)",
  RR: "Round Robin",
  MLFQ: "MLFQ",
};

// Flat route colours, assigned by workload order so a process keeps its colour on every track.
export const ROUTE_COLORS = [
  "#0055a4", "#d06f00", "#1b8a4b", "#7a3e9d", "#00838f", "#b5179e",
  "#5f7d00", "#3a5dae", "#a15c2f", "#b38600", "#4b6b88", "#c2185b",
];

// Non-process segments returned by the backend.
export const SPECIAL = { IDLE: true, CS: true, MIGRATION: true, NUMA: true };

export const state = {
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


export const $ = (id) => document.getElementById(id);
export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// Escape anything interpolated into innerHTML (user input and server echoes of it).
export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "–");
export const fmtTime = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));
// Inline style="" attributes would force 'unsafe-inline' in the CSP, so colours and widths travel
// as data attributes and are applied through the style API after rendering.
export function paint(root) {
  root.querySelectorAll("[data-c]").forEach((el) => (el.style.background = el.dataset.c));
  root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = `${el.dataset.w}%`));
}

export const icon = (id) => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;

export function colorFor(pid) {
  const idx = state.processes.findIndex((p) => p.pid === pid);
  return ROUTE_COLORS[(idx === -1 ? hashIndex(pid) : idx) % ROUTE_COLORS.length];
}

export function hashIndex(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

/* ---------------- Toasts ---------------- */

export function showNotification(message, type = "info") {
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
