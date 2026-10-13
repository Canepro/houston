import { ctx } from "./shared.js";

try {
  document.documentElement.dataset.theme = localStorage.getItem("houston-theme") || "light";
} catch (_) {
  document.documentElement.dataset.theme = "light";
}

function whenReady(name, invoke) {
  const ready = () => typeof ctx[name] === "function"
    ? invoke(ctx[name]) : setTimeout(ready, 0);
  ready();
}

document.addEventListener("click", (event) => {
  const target = event.target.closest(
    "#btn-jobs, #btn-clusters, #btn-scenarios, #btn-backups, #btn-home, #btn-new",
  );
  if (!target) return;
  event.preventDefault();
  const names = {
    "btn-jobs": "openJobs", "btn-clusters": "openClusters",
    "btn-scenarios": "openScenarios", "btn-backups": "openBackups", "btn-home": "goHome",
    "btn-new": "openCreate",
  };
  whenReady(names[target.id], (fn) => target.id === "btn-jobs" ? fn("running") : fn());
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("#doctor-badge, #edge-badge");
  if (!target) return;
  whenReady(target.id === "doctor-badge" ? "openDoctor" : "openEdge", (fn) => fn());
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#theme-toggle")) return;
  whenReady("applyTheme", (applyTheme) => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(ctx.THEME_KEY, next); } catch (_) { /* private mode */ }
  });
});

await import("./main.js");
