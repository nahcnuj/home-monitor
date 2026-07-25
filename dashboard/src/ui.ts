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
  if (grid) {
    grid.innerHTML = [
      { label: "測定数", value: stats.total.toLocaleString() },
      { label: "平均", value: stats.avg ? `${Math.round(stats.avg)}` : "-", unit: "ms" },
      { label: "P95", value: stats.p95 ? `${Math.round(stats.p95)}` : "-", unit: "ms" },
      { label: "最大", value: stats.max ? `${stats.max}` : "-", unit: "ms" },
    ]
      .map(
        (item) => `
    <div class="stat-item">
      <span class="label">${item.label}</span>
      <span class="value">${item.value}${item.unit ? `<span class="unit">${item.unit}</span>` : ""}</span>
    </div>`,
      )
      .join("");
  }

  const uptime = document.getElementById("uptimeBadge");
  if (uptime) {
    if (!stats.total) {
      uptime.innerHTML = `<span class="label">Uptime</span><span class="value">—</span>`;
      uptime.classList.remove("ok", "warn");
      return;
    }
    const cls = stats.uptime < 95 ? "warn" : "ok";
    uptime.classList.toggle("ok", cls === "ok");
    uptime.classList.toggle("warn", cls === "warn");
    uptime.innerHTML =
      `<span class="label">Uptime</span>` +
      `<span class="value">${stats.uptime.toFixed(1)}%</span>`;
  }
}

export function updateRangeUi(): void {
  document.querySelectorAll(".range-btn").forEach((node) => {
    const btn = node as HTMLButtonElement;
    const active = Number(btn.dataset.seconds) === displayRangeSec;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

export function initRangeSelector(onChange: () => void): void {
  const el = document.getElementById("rangeSelector");
  if (!el) return;

  if (!rangeSelectorReady) {
    el.innerHTML = RANGE_PRESETS.map(
      (p) =>
        `<button type="button" class="range-btn" data-seconds="${p.seconds}" aria-pressed="false" aria-label="表示範囲 ${p.label}">${p.label}</button>`,
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