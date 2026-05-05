import { drawChart } from "./chart.js";
import { $ } from "./state.js";

const THEMES = [["light", "Light"], ["dark", "Dark"], ["contrast", "High contrast"]];
const current = () => document.documentElement.dataset.theme || "light";

function show() {
  $("themeBtn").textContent = `Theme: ${THEMES.find(([k]) => k === current())[1]}`;
}

$("themeBtn").addEventListener("click", () => {
  const next = THEMES[(THEMES.findIndex(([k]) => k === current()) + 1) % THEMES.length][0];
  if (next === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("cpusim:theme", next);
  } catch {} // the choice just won't be remembered
  show();
  drawChart();
});

show();
