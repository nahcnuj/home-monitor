import {
  DEFAULT_DISPLAY_RANGE_SEC,
  HOUR_SEC,
  LEGACY_STORAGE_KEY,
  RANGE_PRESETS,
  STORAGE_KEY,
} from "./constants.ts";
import { monitorConfig } from "./config.ts";
import {
  displayRangeSec,
  rangeSelectorReady,
  setDisplayRangeSec,
  setRangeSelectorReady,
} from "./state.ts";
import { isValidDisplayRangeSec } from "./time.ts";
import type { Stats } from "./types.ts";

export function renderStats(stats: Stats): void {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;

  grid.innerHTML = [
    { label: "測定数", value: stats.total.toLocaleString() },
    { label: "平均 (ms)", value: stats.avg ? Math.round(stats.avg) : "-" },
    { label: "P95 (ms)", value: stats.p95 ? Math.round(stats.p95) : "-" },
    { label: "最大 (ms)", value: stats.max || "-" },
    {
      label: "Uptime",
      value: stats.total ? `${stats.uptime.toFixed(1)}%` : "-",
      cls: stats.uptime < 95 ? "error-rate" : "ok",
    },
  ]
    .map(
      (item) => `
    <div class="stat-card">
      <div class="label">${item.label}</div>
      <div class="value ${item.cls || ""}">${item.value}</div>
    </div>`,
    )
    .join("");
}

export function updateRangeUi(): void {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", Number((btn as HTMLButtonElement).dataset.seconds) === displayRangeSec);
  });
}

export function initRangeSelector(onChange: () => void): void {
  const el = document.getElementById("rangeSelector");
  if (!el) return;

  if (!rangeSelectorReady) {
    el.innerHTML = RANGE_PRESETS.map(
      (p) => `<button type="button" class="range-btn" data-seconds="${p.seconds}">${p.label}</button>`,
    ).join("");
    el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".range-btn") as HTMLButtonElement | null;
      if (!btn) return;
      const seconds = Number(btn.dataset.seconds);
      if (!isValidDisplayRangeSec(seconds) || seconds === displayRangeSec) return;
      setDisplayRangeSec(seconds);
      localStorage.setItem(STORAGE_KEY, String(seconds));
      updateRangeUi();
      onChange();
    });
    setRangeSelectorReady(true);
  }
  updateRangeUi();
}

export function loadDisplayRangeFromConfig(): number {
  const configDefaultSec = monitorConfig.display_hours * HOUR_SEC;

  const storedSec = Number(localStorage.getItem(STORAGE_KEY));
  if (isValidDisplayRangeSec(storedSec)) return storedSec;

  const legacyHours = Number(localStorage.getItem(LEGACY_STORAGE_KEY));
  if (isValidDisplayRangeSec(legacyHours * HOUR_SEC)) {
    const sec = legacyHours * HOUR_SEC;
    localStorage.setItem(STORAGE_KEY, String(sec));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return sec;
  }

  return isValidDisplayRangeSec(configDefaultSec) ? configDefaultSec : DEFAULT_DISPLAY_RANGE_SEC;
}