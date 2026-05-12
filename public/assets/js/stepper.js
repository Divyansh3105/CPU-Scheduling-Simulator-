import { drawChart, segmentAt, setClock } from "./chart.js";
import { $, esc, fmtTime, icon, state } from "./state.js";

/* ---------------- Step-through ---------------- */

export const listOf = (items) => items.map(esc).join(", ");

// Plain-English reason for one dispatch from the backend's decision log.
export function reasonText(label, algo, d) {
  const among = d.ready.map((r) => `${r.pid} (${fmtTime(r.value)})`).join(", ");
  const only = d.ready.length === 1;
  const who = `${esc(label)} picks <b>${esc(d.pid)}</b>`;
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

// Processes that have arrived by t, are unfinished, are not on the CPU and are not waiting on I/O.
export function readyAt(run, t) {
  const on = segmentAt(run, t)?.pid;
  const blocked = (pid) => (run.data.ioSchedule ?? []).some((io) => io.pid === pid && io.requestTime <= t && t < io.startTime + io.ioTime);
  return run.data.results.filter((p) => p.arrival <= t && p.completion > t && p.pid !== on && !blocked(p.pid)).map((p) => p.pid);
}

// Hypervisor runs have no dispatch log, so say what the CPU is doing instead of "No dispatch yet".
function nowRunning(run, t) {
  const s = segmentAt(run, t);
  if (!s || s.pid === "IDLE") return "The CPU is idle.";
  const what = { CS: "context switch", MIGRATION: "migration", NUMA: "NUMA hop" }[s.pid];
  return what ? `The CPU is in a ${what}.` : `<b>${esc(s.pid)}</b> is on the CPU${s.vm && s.vm !== "Host" ? ` (${esc(s.vm)})` : ""}.`;
}

export function renderStep() {
  const box = $("stepper");
  box.hidden = !state.runs.length;
  if (box.hidden) return;
  const t = state.clock;
  $("stepPanel").innerHTML =
    t === null
      ? `<p class="step-hint">Press Play or Step to walk through the schedule one decision at a time.</p>`
      : state.runs
          .map((run) => {
            const logged = run.data.decisions?.length > 0;
            const d = logged ? run.data.decisions.filter((x) => x.time <= t).pop() : null;
            const ready = readyAt(run, t);
            return (
              `<div class="step-row"><h4>${esc(run.label)}</h4>` +
              `<p>${logged ? (d ? reasonText(run.label, run.base, d) + ` <span class="step-at">(decided at t ${fmtTime(d.time)})</span>` : "No dispatch yet.") : nowRunning(run, t)}</p>` +
              `<p class="step-queue">Ready at t ${fmtTime(t)}: ${ready.length ? listOf(ready) : "nobody waiting"}</p></div>`
            );
          })
          .join("") +
        (state.runs.some((r) => r.data.decisionsTruncated) ? `<p class="step-hint">Reasons are logged for the first 1000 dispatches of each run.</p>` : "");
}

// Step jumps to the next (or previous) moment any track made a dispatch decision.
export function stepClock(dir) {
  // Without a decision log (hypervisor mode) step between segment boundaries instead.
  const moments = (r) => (r.data.decisions?.length ? r.data.decisions.map((d) => d.time) : r.data.segments.map((s) => s.start));
  const times = [...new Set(state.runs.flatMap(moments))].sort((a, b) => a - b);
  const now = state.clock ?? -1;
  const next = dir > 0 ? times.find((x) => x > now) : times.filter((x) => x < now).pop();
  if (next === undefined) {
    if (dir > 0) stopPlay();
    return;
  }
  setClock(next);
}

export let playTimer = null;
export function stopPlay() {
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
$("stepNext").addEventListener("click", () => { stopPlay(); stepClock(1); announce(); });
$("stepBack").addEventListener("click", () => { stopPlay(); stepClock(-1); announce(); });

// Only Step and Back are announced; dragging or playing would repeat the panel on every tick.
function announce() {
  $("stepAnnounce").textContent = $("stepPanel").innerText.replace(/\s*\n+\s*/g, ". ");
}

export let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 120);
});
