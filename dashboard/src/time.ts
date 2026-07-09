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

export function getDisplayCutoff(dataCutoffTs: number): number {
  const rolling = Math.floor(Date.now() / 1000) - displayRangeSec;
  return Math.max(rolling, dataCutoffTs);
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

export function chartTimeBounds(nowSec?: number, compact?: boolean): TimeBounds {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const rangeSec = displayRangeSec;
  const useCompact = compact ?? isCompactChartLayout();
  const tickStep = chartTickStep(rangeSec, useCompact);
  let max: number;
  if (rangeSec > DAY_SEC) {
    max = nextJstDay(now);
  } else if (rangeSec < HOUR_SEC) {
    max = ceilToMinute(now);
  } else {
    max = ceilToJstHour(now);
  }
  return { min: max - rangeSec, max, range: rangeSec, tickStep };
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