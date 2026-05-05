// Runs before first paint (classic script in <head>) so a saved theme does not flash light first.
try {
  const t = localStorage.getItem("cpusim:theme");
  if (t === "dark" || t === "contrast") document.documentElement.dataset.theme = t;
} catch {}
