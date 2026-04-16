import { drawChart } from "./chart.js";
import { renderResults } from "./results.js";
import { reduceMotion } from "./state.js";
import { renderProcessTable, renderVMOptions, renderVMTable } from "./workload.js";

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
renderResults();
document.fonts?.ready.then(drawChart);
