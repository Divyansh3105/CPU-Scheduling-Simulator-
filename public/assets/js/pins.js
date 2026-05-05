import { $, esc, icon, showNotification, state } from "./state.js";
import { settingsChanged } from "./workload.js";

const MAX_PINS = 6;
const SHORT = { FCFS: "FCFS", SJF: "SJF", SRTF: "SRTF", PRIORITY: "Pri", PRIORITYP: "Pri (P)", RR: "RR", MLFQ: "MLFQ" };
let pinSeq = 0;

export const currentParams = () => ({
  quantum: parseInt($("quantum").value, 10) || 2,
  aging: parseInt($("priorityAging").value, 10) || 0,
  mlfqBoost: parseInt($("mlfqBoost").value, 10) || 0,
  csOverhead: parseFloat($("contextSwitchOverhead").value) || 0,
});

// "RR q=2 cs 1": only the settings that algorithm actually uses.
function pinLabel(base, p) {
  const bits = [];
  if (base === "RR" || base === "MLFQ") bits.push(`q=${p.quantum}`);
  if (base === "MLFQ" && p.mlfqBoost) bits.push(`boost ${p.mlfqBoost}`);
  if ((base === "PRIORITY" || base === "PRIORITYP") && p.aging) bits.push(`aging ${p.aging}`);
  bits.push(`cs ${p.csOverhead}`);
  return `${SHORT[base]} ${bits.join(" ")}`;
}

export function addPin(base, params) {
  const label = pinLabel(base, params);
  if (state.pins.some((p) => p.label === label)) return false;
  if (state.pins.length >= MAX_PINS) {
    showNotification(`At most ${MAX_PINS} pinned runs.`, "error");
    return false;
  }
  state.pins.push({ id: `pin${++pinSeq}`, base, params, label });
  return true;
}

export function renderPins() {
  $("pins").innerHTML = state.pins
    .map((p) => `<span class="pin"><span>${esc(p.label)}</span><button type="button" class="icon-btn" data-pin="${p.id}" aria-label="Unpin ${esc(p.label)}">${icon("i-x")}</button></span>`)
    .join("");
  $("pins").querySelectorAll("[data-pin]").forEach((b) =>
    b.addEventListener("click", () => {
      state.pins = state.pins.filter((p) => p.id !== b.dataset.pin);
      renderPins();
      settingsChanged();
    })
  );
}

$("pinBtn").addEventListener("click", () => {
  const params = currentParams();
  const algos = [...document.querySelectorAll("#algoChips input:checked")].map((i) => i.value);
  if (!algos.length) return showNotification("Check an algorithm to pin.", "error");
  if (!algos.map((a) => addPin(a, params)).some(Boolean)) return showNotification("Already pinned with these settings.", "info");
  renderPins();
  settingsChanged();
});
