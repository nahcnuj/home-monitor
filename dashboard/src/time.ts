import {
  DAY_SEC,
  HOUR_SEC,
  JST_OFFSET,
  jstFormatter,
  MIN_SEC,
  RANGE_PRESETS,
} from "./constants.ts";
import { displayRangeSec } from "./state.ts";
import type { TimeBounds } from "./types.ts";

export const fmtJst = (unixSec: number): string =>
  jstFormatter.format(new Date(unixSec * 1000));

/**
 * Records older than this are excluded from the dashboard.
 * The selected range preset no longer trims history — it only controls how much
 * time fits across the visible chart width (see chartTimeBounds).
 */
export function getDisplayCutoff(dataCutoffTs: number): number {
  return dataCutoffTs;
}

function floorToJstDay(unixSec: number): number {
  return Math.floor((unixSec + JST_OFFSET) / DAY_SEC) * DAY_SEC - JST_OFFSET;
}

function nextJstDay(unixSec: number): number {
  return floorToJstDay(unixSec) + DAY_SEC;
}

export function ceilToJstHour(unixSec: number): number {
  return Math.ceil((unixSec + JST_OFFSET) / HOUR_SEC) * HOUR_SEC - JST_OFFSET;
}

function ceilToMinute(unixSec: number): number {
  return Math.ceil(unixSec / MIN_SEC) * MIN_SEC;
}

export function isJstOnTheHour(unixSec: number): boolean {
  return (unixSec + JST_OFFSET) % HOUR_SEC === 0;
}

export function isJstMidnight(unixSec: number): boolean {
  return (unixSec + JST_OFFSET) % DAY_SEC === 0;
}

/** Matches the PC dashboard media query in style.css (wide + tall enough). */
export function isCompactChartLayout(
  width = typeof window !== "undefined" ? window.innerWidth : 1200,
  height = typeof window !== "undefined" ? window.innerHeight : 800,
): boolean {
  return width < 1000 || height < 600;
}

export function chartTickStep(rangeSec: number, compact = false): number {
  if (compact) {
    // Fewer labels on narrow screens so x-axis text does not overlap.
    if (rangeSec <= 10 * MIN_SEC) return 5 * MIN_SEC;
    if (rangeSec <= 30 * MIN_SEC) return 10 * MIN_SEC;
    if (rangeSec <= HOUR_SEC) return 15 * MIN_SEC;
    if (rangeSec <= 3 * HOUR_SEC) return HOUR_SEC;
    if (rangeSec <= 6 * HOUR_SEC) return 2 * HOUR_SEC;
    if (rangeSec <= 12 * HOUR_SEC) return 3 * HOUR_SEC;
    if (rangeSec <= 24 * HOUR_SEC) return 6 * HOUR_SEC;
    if (rangeSec <= 72 * HOUR_SEC) return DAY_SEC;
    return DAY_SEC;
  }
  if (rangeSec <= 10 * MIN_SEC) return 2 * MIN_SEC;
  if (rangeSec <= 30 * MIN_SEC) return 5 * MIN_SEC;
  if (rangeSec <= HOUR_SEC) return 10 * MIN_SEC;
  if (rangeSec <= 6 * HOUR_SEC) return HOUR_SEC;
  if (rangeSec <= 12 * HOUR_SEC) return 2 * HOUR_SEC;
  if (rangeSec <= 24 * HOUR_SEC) return 3 * HOUR_SEC;
  if (rangeSec <= 72 * HOUR_SEC) return 12 * HOUR_SEC;
  return DAY_SEC;
}

export interface ChartTimeBoundsOptions {
  /** Earliest record timestamp (unix sec). Extends the chart left so history is scrollable. */
  dataMinTs?: number;
  /** Hard floor from config; never draw older than this. */
  dataCutoffTs?: number;
}

/**
 * X-axis domain for the latency chart.
 * - `viewportSec` (selected range) = how much time the visible width represents.
 * - Full span runs from available history (or one viewport) through aligned “now”.
 * Default view scrolls to the right edge so the most recent viewport is on screen.
 */
export function chartTimeBounds(
  nowSec?: number,
  compact?: boolean,
  options?: ChartTimeBoundsOptions,
): TimeBounds {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const viewportSec = displayRangeSec;
  const useCompact = compact ?? isCompactChartLayout();
  let max: number;
  if (viewportSec > DAY_SEC) {
    max = nextJstDay(now);
  } else if (viewportSec < HOUR_SEC) {
    max = ceilToMinute(now);
  } else {
    max = ceilToJstHour(now);
  }

  // At least one viewport ending at `max`; extend further left when older data exists.
  let min = max - viewportSec;
  const dataMin = options?.dataMinTs;
  if (dataMin != null && Number.isFinite(dataMin) && dataMin < min) {
    min = dataMin;
  }
  const cutoff = options?.dataCutoffTs ?? 0;
  if (cutoff > 0) {
    min = Math.max(min, cutoff);
  }
  if (min >= max) {
    min = max - viewportSec;
  }

  const range = max - min;
  // Tick density follows the zoom (viewport); for long history, coarsen so Chart.js
  // does not try to mint thousands of major ticks across the full span.
  const tickBasis =
    range > viewportSec * 2 ? Math.max(viewportSec, range / 16) : viewportSec;
  const tickStep = chartTickStep(tickBasis, useCompact);

  return {
    min,
    max,
    range,
    viewportSec,
    tickStep,
  };
}

export function rangeLabel(seconds: number): string {
  return RANGE_PRESETS.find((p) => p.seconds === seconds)?.label ?? `${Math.round(seconds / HOUR_SEC)}h`;
}

export function isValidDisplayRangeSec(seconds: number): boolean {
  return RANGE_PRESETS.some((p) => p.seconds === seconds);
}

export function fmtAxisTick(
  unixSec: number,
  tickStep: number,
  compact = false,
): string {
  // Compact: short clock for sub-day steps; month/day only for day-scale ticks.
  if (compact) {
    if (tickStep >= DAY_SEC) {
      return new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(unixSec * 1000));
    }
    if (tickStep >= HOUR_SEC && isJstMidnight(unixSec)) {
      return new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(unixSec * 1000));
    }
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(unixSec * 1000));
  }

  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    ...(tickStep < DAY_SEC ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
  return fmt.format(new Date(unixSec * 1000));
}