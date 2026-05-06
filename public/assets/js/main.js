import { drawChart } from "./chart.js";
import { restore } from "./persist.js";
import { renderPins } from "./pins.js";
import "./alt.js";
import { renderResults } from "./results.js";
import "./theme.js";
import { reduceMotion } from "./state.js";
import { renderProcessTable, renderVMOptions, renderVMTable } from "./workload.js";

// Pages hosting cannot send frame-ancestors, so hide the app if something frames it.
if (window.top !== window.self) document.documentElement.hidden = true;

/* ---------------- Smooth scrolling ---------------- */

if (window.Lenis && window.gsap && !reduceMotion.matches) {
  const lenis = new Lenis({ lerp: 0.14 });
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
}

/* ---------------- Init ---------------- */

renderProcessTable();
renderVMTable();
renderVMOptions();
renderPins();
renderResults();
restore();
document.fonts?.ready.then(drawChart);
