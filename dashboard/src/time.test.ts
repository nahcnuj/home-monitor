import { describe, expect, it } from "vitest";
import { DAY_SEC, HOUR_SEC, JST_OFFSET, MIN_SEC, RANGE_PRESETS } from "./constants.ts";
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
    expect(bounds.viewportSec).toBe(rangeSec);
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
    expect(bounds.viewportSec).toBe(rangeSec);
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

  it("extends the left edge to older data while keeping viewportSec as the selected range", () => {
    setDisplayRangeSec(HOUR_SEC);
    const dataMinTs = SAMPLE_NOW - 6 * HOUR_SEC;
    const bounds = chartTimeBounds(SAMPLE_NOW, false, { dataMinTs });
    expect(bounds.viewportSec).toBe(HOUR_SEC);
    expect(bounds.min).toBe(dataMinTs);
    expect(bounds.range).toBeGreaterThan(HOUR_SEC);
    expect(bounds.max - bounds.min).toBe(bounds.range);
  });

  it("does not extend left past data_cutoff_ts", () => {
    setDisplayRangeSec(HOUR_SEC);
    const dataMinTs = SAMPLE_NOW - 6 * HOUR_SEC;
    const dataCutoffTs = SAMPLE_NOW - 2 * HOUR_SEC;
    const bounds = chartTimeBounds(SAMPLE_NOW, false, { dataMinTs, dataCutoffTs });
    expect(bounds.min).toBe(dataCutoffTs);
  });

  it("ends the 30m range at the latest data timestamp (rounded up to a minute)", () => {
    setDisplayRangeSec(30 * MIN_SEC);
    const dataMaxTs = SAMPLE_NOW - 5 * MIN_SEC - 10; // 23:20-ish
    const bounds = chartTimeBounds(SAMPLE_NOW, false, { dataMaxTs });
    expect(bounds.max).toBe(Math.ceil(dataMaxTs / MIN_SEC) * MIN_SEC);
    expect(bounds.min).toBe(bounds.max - 30 * MIN_SEC);
    expect(bounds.viewportSec).toBe(30 * MIN_SEC);
  });

  it("ends the 1h range at the latest data timestamp (rounded up to a JST hour)", () => {
    setDisplayRangeSec(HOUR_SEC);
    const dataMaxTs = SAMPLE_NOW - 30 * MIN_SEC;
    const bounds = chartTimeBounds(SAMPLE_NOW, false, { dataMaxTs });
    expect(bounds.max).toBe(Math.ceil((dataMaxTs + JST_OFFSET) / HOUR_SEC) * HOUR_SEC - JST_OFFSET);
    expect(bounds.min).toBe(bounds.max - HOUR_SEC);
  });

  it("falls back to now when dataMaxTs is missing or invalid", () => {
    setDisplayRangeSec(30 * MIN_SEC);
    const withMissing = chartTimeBounds(SAMPLE_NOW, false, { dataMaxTs: undefined });
    const withNaN = chartTimeBounds(SAMPLE_NOW, false, { dataMaxTs: NaN });
    expect(withMissing.max).toBe(Math.ceil(SAMPLE_NOW / MIN_SEC) * MIN_SEC);
    expect(withNaN.max).toBe(Math.ceil(SAMPLE_NOW / MIN_SEC) * MIN_SEC);
  });

  it("extends the left edge to older data when ending at latest data", () => {
    setDisplayRangeSec(30 * MIN_SEC);
    const dataMaxTs = SAMPLE_NOW;
    const dataMinTs = SAMPLE_NOW - 3 * HOUR_SEC;
    const bounds = chartTimeBounds(SAMPLE_NOW, false, { dataMinTs, dataMaxTs });
    expect(bounds.max).toBe(Math.ceil(dataMaxTs / MIN_SEC) * MIN_SEC);
    expect(bounds.min).toBe(dataMinTs);
    expect(bounds.range).toBeGreaterThan(30 * MIN_SEC);
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