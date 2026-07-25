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
import { fmtJst, isValidDisplayRangeSec } from "./time.ts";
import type { Stats } from "./types.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Preset label for the selected display range (viewport width in time). */
export function rangePresetLabel(seconds: number = displayRangeSec): string {
  return RANGE_PRESETS.find((p) => p.seconds === seconds)?.label ?? `${seconds}s`;
}

/**
 * Labels for the chart outline / chip: selected range = visible window on the plot.
 * `min`/`max` are the current pan window (unix sec).
 */
export function renderViewportChrome(min: number, max: number): void {
  const duration = rangePresetLabel();
  const startText = Number.isFinite(min) ? fmtJst(min) : "—";
  const endText = Number.isFinite(max) ? fmtJst(max) : "—";
  const bounds = `${startText} → ${endText}`;

  const setText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText("viewportDuration", duration);
  setText("viewportFrameDuration", duration);
  setText("viewportBounds", bounds);
  setText("viewportStartLabel", startText);
  setText("viewportEndLabel", endText);

  const caption = document.getElementById("rangeCaption");
  if (caption) {
    caption.textContent = `${duration} = グラフ横幅の時間 · 枠の「始〜終」がいまの窓`;
  }

  const chip = document.getElementById("viewportChip");
  if (chip) {
    chip.setAttribute("aria-label", `表示中 ${duration}、${startText} から ${endText}`);
  }
}

export function renderStats(stats: Stats): void {
  const grid = document.getElementById("statsGrid");
  if (grid) {
    const items: Array<{ label: string; value: string; unit?: string }> = [
      { label: "測定数", value: stats.total.toLocaleString() },
      {
        label: "平均",
        value: stats.avg != null && stats.avg > 0 ? `${Math.round(stats.avg)}` : "—",
        unit: "ms",
      },
      {
        label: "P95",
        value: stats.p95 != null && stats.p95 > 0 ? `${Math.round(stats.p95)}` : "—",
        unit: "ms",
      },
      {
        label: "最大",
        value: stats.max != null && stats.max > 0 ? `${stats.max}` : "—",
        unit: "ms",
      },
    ];

    grid.innerHTML = items
      .map(
        (item) => `
      <div class="kpi">
        <span class="label">${escapeHtml(item.label)}</span>
        <span class="value">${escapeHtml(item.value)}${
          item.unit ? `<span class="unit">${escapeHtml(item.unit)}</span>` : ""
        }</span>
      </div>`,
      )
      .join("");
  }

  const uptime = document.getElementById("uptimeBadge");
  if (uptime) {
    if (!stats.total) {
      uptime.classList.remove("ok", "warn");
      uptime.innerHTML =
        `<span class="uptime-label">Uptime</span>` +
        `<span class="uptime-value">—</span>`;
      return;
    }
    const cls = stats.uptime < 95 ? "warn" : "ok";
    uptime.classList.toggle("ok", cls === "ok");
    uptime.classList.toggle("warn", cls === "warn");
    const pct = stats.uptime.toFixed(1);
    uptime.innerHTML =
      `<span class="uptime-label">Uptime</span>` +
      `<span class="uptime-value">${pct}<span class="unit">%</span></span>`;
  }
}

export function updateRangeUi(): void {
  const label = rangePresetLabel();
  document.querySelectorAll(".range-btn").forEach((node) => {
    const btn = node as HTMLButtonElement;
    const active = Number(btn.dataset.seconds) === displayRangeSec;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    if (active) {
      btn.setAttribute("title", `表示範囲 ${label}（グラフの横幅）`);
    } else {
      btn.removeAttribute("title");
    }
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
