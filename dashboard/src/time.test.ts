import { describe, expect, it } from "vitest";
import { DAY_SEC, HOUR_SEC, MIN_SEC, RANGE_PRESETS } from "./constants.ts";
import { setDisplayRangeSec } from "./state.ts";
import {
  chartTimeBounds,
  chartTickStep,
  isJstMidnight,
  isJstOnTheHour,
} from "./time.ts";

// 2026-06-20 23:25:05 JST
const SAMPLE_NOW = Date.UTC(2026, 5, 20, 14, 25, 5) / 1000;

describe("chartTimeBounds", () => {
  it.each(
    RANGE_PRESETS.filter((preset) => preset.seconds >= HOUR_SEC && preset.seconds <= DAY_SEC).map(
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
  )("aligns the right edge to the minute for short ranges (%s)", (_label, rangeSec) => {
    setDisplayRangeSec(rangeSec);
    const bounds = chartTimeBounds(SAMPLE_NOW);
    expect(bounds.max % MIN_SEC).toBe(0);
    expect(isJstOnTheHour(bounds.max)).toBe(false);
  });

  it("uses the next JST hour for the 1h preset", () => {
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