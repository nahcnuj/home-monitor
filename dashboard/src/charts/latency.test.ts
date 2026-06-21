import { Chart, registerables } from "chart.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateByServer, filterByPeriod, parseTsv } from "../data.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./plugins.ts";
import {
  buildFailurePoints,
  buildLatencyChart,
  buildTooltipLines,
  collectActiveElementsAtBatch,
  formatFailureLabel,
  getLatencyChart,
  isTooltipDataset,
  nearestBatchTs,
} from "./latency.ts";
import { buildErrorChart } from "./error.ts";
import { sampleTsv } from "../test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "../state.ts";
import { chartTimeBounds, isJstOnTheHour } from "../time.ts";
import { DAY_SEC, HOUR_SEC } from "../constants.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

beforeAll(() => {
  document.body.innerHTML = `
    <canvas id="latencyChart" width="800" height="400"></canvas>
    <canvas id="errorChart" width="800" height="200"></canvas>
  `;
});

describe("nearestBatchTs", () => {
  it("snaps hover to the nearest measurement batch timestamp", () => {
    const batches = [1000, 1060, 1120];
    expect(nearestBatchTs(batches, 1000)).toBe(1000);
    expect(nearestBatchTs(batches, 1029)).toBe(1000);
    expect(nearestBatchTs(batches, 1031)).toBe(1060);
  });
});

describe("buildTooltipLines", () => {
  it("lists every domain at the same batch timestamp", () => {
    const records = parseTsv([
      "1782003423\t203.165.31.152\tamazon.co.jp\t\ttimeout",
      "1782003423\t203.165.31.152\tgoogle.com\t\ttimeout",
      "1782003423\t203.165.31.152\tline.me\t188",
      "1782003483\t203.165.31.152\tyahoo.co.jp\t201",
    ].join("\n"));

    expect(buildTooltipLines(records, 1782003423)).toEqual([
      "line.me: 188 ms",
      "203.165.31.152 / amazon.co.jp: timeout",
      "203.165.31.152 / google.com: timeout",
    ]);
    expect(buildTooltipLines(records, 1782003483)).toEqual(["yahoo.co.jp: 201 ms"]);
  });
});

describe("collectActiveElementsAtBatch", () => {
  it("selects every success and failure point at the same timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1782008900 * 1000));
    setDisplayRangeSec(24 * 3600);
    setDataCutoffTs(0);

    const records = parseTsv([
      "1782008823\t203.165.31.152\tamazon.co.jp\t167",
      "1782008823\t203.165.31.152\tapple.com\t228",
      "1782008823\t203.165.31.152\tcloudflare.com\t232",
      "1782008823\t203.165.31.152\tgithub.com\t\ttimeout",
      "1782008823\t203.165.31.152\tgoogle.com\t\ttimeout",
      "1782008823\t203.165.31.152\tline.me\t\ttimeout",
      "1782008823\t203.165.31.152\tmicrosoft.com\t\ttimeout",
      "1782008823\t203.165.31.152\tyahoo.co.jp\t\ttimeout",
    ].join("\n"));
    const filtered = filterByPeriod(records, 0);
    const { successes, failures } = aggregateByServer(filtered);

    buildLatencyChart(filtered, successes, failures, 0);
    const chart = getLatencyChart();
    expect(chart).not.toBeNull();

    const active = collectActiveElementsAtBatch(chart!, 1782008823);
    expect(active).toHaveLength(8);
    expect(isTooltipDataset("203.165.31.152")).toBe(true);
    expect(isTooltipDataset("Failures")).toBe(true);
    expect(isTooltipDataset("203.165.31.152 q1")).toBe(false);

    vi.useRealTimers();
  });
});

describe("buildFailurePoints", () => {
  it("keeps every failure domain at the same timestamp", () => {
    const records = parseTsv([
      "1782003423\t203.165.31.152\tamazon.co.jp\t\ttimeout",
      "1782003423\t203.165.31.152\tgoogle.com\t\ttimeout",
      "1782003423\t203.165.31.152\tline.me\t188",
    ].join("\n"));

    const points = buildFailurePoints(records);
    expect(points).toHaveLength(2);
    expect(points.map((point) => point.domain).sort()).toEqual(["amazon.co.jp", "google.com"]);
    expect(formatFailureLabel(points[0])).toBe("203.165.31.152 / amazon.co.jp: timeout");
  });
});

describe("buildLatencyChart", () => {
  beforeAll(() => {
    setDisplayRangeSec(3600);
    setDataCutoffTs(1781967600);
  });

  it("renders charts from published TSV without throwing", () => {
    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781967600);
    const { successes, failures } = aggregateByServer(filtered);
    const stats = failures.reduce<Record<string, number>>((acc, row) => {
      acc[row.error] = (acc[row.error] || 0) + 1;
      return acc;
    }, {});

    expect(() => {
      buildLatencyChart(filtered, successes, failures, 1781967600);
      buildErrorChart(stats);
    }).not.toThrow();

    expect(getLatencyChart()).not.toBeNull();
  });

  it("anchors the x-axis to latest data for sub-hour ranges", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1781967900 * 1000));

    setDisplayRangeSec(HOUR_SEC);
    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781967600);
    const { successes, failures } = aggregateByServer(filtered);
    const latestTs = Math.max(...filtered.map((r) => r.ts));

    buildLatencyChart(filtered, successes, failures, 1781967600);

    const chart = getLatencyChart();
    const expected = chartTimeBounds(undefined, latestTs);
    expect(chart?.options.scales?.x?.max).toBe(expected.max);
    expect(expected.max).toBeLessThan(chartTimeBounds(undefined, null).max);

    vi.useRealTimers();
  });

  it("pins the x-axis right edge to JST on-the-hour for the default 24h range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 20, 14, 25, 5)));

    setDisplayRangeSec(DAY_SEC);
    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781967600);
    const { successes, failures } = aggregateByServer(filtered);

    buildLatencyChart(filtered, successes, failures, 1781967600);

    const chart = getLatencyChart();
    const expected = chartTimeBounds();
    const xMax = chart?.options.scales?.x?.max;
    expect(xMax).toBe(expected.max);
    expect(isJstOnTheHour(Number(xMax))).toBe(true);

    vi.useRealTimers();
  });

  it("renders when no records fall in the display window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1900000000 * 1000));

    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 0);
    expect(filtered).toHaveLength(0);

    expect(() => {
      buildLatencyChart(filtered, [], [], 0);
      buildErrorChart({});
    }).not.toThrow();

    vi.useRealTimers();
  });
});