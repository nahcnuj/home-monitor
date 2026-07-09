import { describe, expect, it } from "vitest";
import { DAY_SEC, HOUR_SEC, MIN_SEC, RANGE_PRESETS } from "./constants.ts";
import { setDisplayRangeSec } from "./state.ts";
import {
  chartTimeBounds,
  chartTickStep,
  fmtAxisTick,
  isCompactChartLayout,
  isJstMidnight,
  isJstOnTheHour,
} from "./time.ts";

// 2026-06-20 23:25:05 JST
const SAMPLE_NOW = Date.UTC(2026, 5, 20, 14, 25, 5) / 1000;

describe("chartTimeBounds", () => {
  it.each(
    RANGE_PRESETS.filter((preset) => preset.seconds > HOUR_SEC && preset.seconds <= DAY_SEC).map(
      (preset) => [preset.label, preset.seconds] as const,
    ),
  )("aligns the right edge to JST on-the-hour for %s", (_label, rangeSec) => {
    setDisplayRangeSec(rangeSec);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    expect(isJstOnTheHour(bounds.max)).toBe(true);
    expect(bounds.min).toBe(bounds.max - rangeSec);
    expect(bounds.range).toBe(rangeSec);
    expect(bounds.tickStep).toBe(chartTickStep(rangeSec));
  });

  it.each(
    RANGE_PRESETS.filter((preset) => preset.seconds > DAY_SEC).map(
      (preset) => [preset.label, preset.seconds] as const,
    ),
  )("aligns the right edge to the next JST midnight for %s", (_label, rangeSec) => {
    setDisplayRangeSec(rangeSec);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    expect(isJstMidnight(bounds.max)).toBe(true);
    expect(bounds.max).toBeGreaterThan(SAMPLE_NOW);
    expect(bounds.min).toBe(bounds.max - rangeSec);
  });

  it.each(
    RANGE_PRESETS.filter((preset) => preset.seconds < HOUR_SEC).map(
      (preset) => [preset.label, preset.seconds] as const,
    ),
  )("falls back to the current minute when short ranges have no data (%s)", (_label, rangeSec) => {
    setDisplayRangeSec(rangeSec);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    expect(bounds.max % MIN_SEC).toBe(0);
    expect(bounds.max).toBe(Math.ceil(SAMPLE_NOW / MIN_SEC) * MIN_SEC);
  });

  it("uses the next JST hour for the 1h preset without data", () => {
    setDisplayRangeSec(HOUR_SEC);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    expect(bounds.max).toBe(SAMPLE_NOW - (SAMPLE_NOW % HOUR_SEC) + HOUR_SEC);
    expect(isJstOnTheHour(bounds.max)).toBe(true);
  });


  it("uses the next JST midnight for the 24h preset at 23:25 JST", () => {
    setDisplayRangeSec(DAY_SEC);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    const expectedMax = Date.UTC(2026, 5, 20, 15, 0, 0) / 1000;
    expect(bounds.max).toBe(expectedMax);
    expect(isJstMidnight(bounds.max)).toBe(true);
  });
});

describe("isCompactChartLayout", () => {
  it("matches the PC dashboard breakpoint (wide and tall enough)", () => {
    expect(isCompactChartLayout(1200, 800)).toBe(false);
    expect(isCompactChartLayout(1000, 600)).toBe(false);
    expect(isCompactChartLayout(999, 800)).toBe(true);
    expect(isCompactChartLayout(1200, 599)).toBe(true);
  });
});

describe("chartTickStep compact", () => {
  it("uses coarser steps than desktop for common ranges", () => {
    expect(chartTickStep(30 * MIN_SEC, true)).toBeGreaterThan(chartTickStep(30 * MIN_SEC, false));
    expect(chartTickStep(HOUR_SEC, true)).toBeGreaterThan(chartTickStep(HOUR_SEC, false));
    expect(chartTickStep(DAY_SEC, true)).toBe(6 * HOUR_SEC);
    expect(chartTickStep(DAY_SEC, false)).toBe(3 * HOUR_SEC);
    expect(chartTickStep(72 * HOUR_SEC, true)).toBe(DAY_SEC);
    expect(chartTickStep(72 * HOUR_SEC, false)).toBe(12 * HOUR_SEC);
  });
});

describe("fmtAxisTick compact", () => {
  // 2026-06-20 23:00:00 JST
  const sampleTs = Date.UTC(2026, 5, 20, 14, 0, 0) / 1000;

  it("uses short time-only labels for sub-day steps", () => {
    const compact = fmtAxisTick(sampleTs, HOUR_SEC, true);
    const full = fmtAxisTick(sampleTs, HOUR_SEC, false);
    expect(compact.length).toBeLessThan(full.length);
    expect(compact).toMatch(/\d{1,2}:\d{2}/);
  });

  it("keeps month/day for day-scale ticks", () => {
    expect(fmtAxisTick(sampleTs, DAY_SEC, true)).toMatch(/\d{1,2}/);
  });
});