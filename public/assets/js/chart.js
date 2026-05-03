import { selectRun } from "./results.js";
import { timelineEnd } from "./run.js";
import { $, ALGO_LABELS, SPECIAL, colorFor, esc, fmt, fmtTime, reduceMotion, state } from "./state.js";
import { renderStep } from "./stepper.js";

/* ---------------- Timetable chart ---------------- */

export const canvas = $("timetable");
export const ctx = canvas.getContext("2d");
export const G = { left: 132, right: 28, axis: 34, arrivals: 34, track: 54, bottom: 14, bar: 26 };
export const COND = `"Barlow Semi Condensed", Barlow, sans-serif`;

export function niceStep(span, maxTicks) {
  const raw = span / Math.max(1, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(raw));
  return Math.max([1, 2, 5, 10].find((m) => m * pow >= raw) * pow, 1);
}

// Segments are in time order and do not overlap, so binary search for the last one starting at or before t.
export function segmentAt(run, t) {
  const segs = run.data.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  return s && s.start <= t && t < s.end ? s : null;
}

// Pointer moves can fire faster than the screen refreshes; draw at most once per frame.
let drawQueued = false;
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawChart();
  });
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function drawChart() {
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

export function hatch(x0, y0, w, h, color) {
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

export function roundRect(x0, y0, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
  ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
  ctx.arcTo(x0, y0 + h, x0, y0, r);
  ctx.arcTo(x0, y0, x0 + w, y0, r);
  ctx.closePath();
}

// The one authored motion: trains run in along every track at once, left to right.
export function revealChart() {
  if (!window.gsap || reduceMotion.matches) {
    state.progress = 1;
    drawChart();
    return;
  }
  gsap.killTweensOf(state);
  state.progress = 0;
  gsap.to(state, { progress: 1, duration: 0.7, ease: "expo.out", onUpdate: drawChart });
}

export function timeAt(e) {
  const g = state.geom;
  return ((e.clientX - canvas.getBoundingClientRect().left - g.left) / g.plotW) * g.end;
}

export function runAt(e) {
  const g = state.geom;
  const i = Math.floor((e.clientY - canvas.getBoundingClientRect().top - g.top) / G.track);
  return i >= 0 && i < state.runs.length ? state.runs[i] : null;
}

export const snapTime = (t) => Math.min(state.geom.end, Math.max(0, Math.round(t * 2) / 2));

export let dragging = false;

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

export function setClock(t) {
  state.clock = t;
  renderReadout();
  renderStep();
  queueDraw();
}

export function setHover(pid, info = null) {
  if (state.hoverPid === pid && !info) return;
  state.hoverPid = pid;
  canvas.style.cursor = pid ? "pointer" : "crosshair";
  renderReadout(info);
  queueDraw();
}

export function renderReadout(info = null) {
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
    const done = !s && t >= (r.data.segments.at(-1)?.end ?? 0);
    const what =
      done ? "done" : !s || s.pid === "IDLE" ? "idle" : s.pid === "CS" ? "switching" : s.pid === "MIGRATION" ? "migrating" : `<b>${esc(s.pid)}</b>`;
    return `${ALGO_LABELS[r.algo]} ${what}`;
  });
  el.innerHTML = `<span class="now">t = ${fmtTime(t)}</span> · ${parts.join(" · ")}`;
}
