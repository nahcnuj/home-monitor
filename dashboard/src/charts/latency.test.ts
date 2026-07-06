import { Chart, registerables } from "chart.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateByServer, ceilingToHundred, computeStats, filterByPeriod, parseTsv } from "../data.ts";
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
  shouldShowLatencyPoints,
} from "./latency.ts";
import { buildErrorChart } from "./error.ts";
import { sampleTsv } from "../test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "../state.ts";
import { chartTimeBounds, isJstOnTheHour } from "../time.ts";
import { DAY_SEC, HIDE_LATENCY_POINTS_RANGE_SEC, HOUR_SEC } from "../constants.ts";

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
      "203.165.31.152 / line.me: 188 ms",
      "203.165.31.152 / amazon.co.jp: タイムアウト（旧）",
      "203.165.31.152 / google.com: タイムアウト（旧）",
    ]);
    expect(buildTooltipLines(records, 1782003483)).toEqual(["203.165.31.152 / yahoo.co.jp: 201 ms"]);
  });

  it("lists each resolver separately at the same batch timestamp", () => {
    const records = parseTsv([
      "1782003423\t203.165.31.152\tline.me\t188",
      "1782003423\t122.197.254.136\tline.me\t210",
    ].join("\n"));

    expect(buildTooltipLines(records, 1782003423)).toEqual([
      "122.197.254.136 / line.me: 210 ms",
      "203.165.31.152 / line.me: 188 ms",
    ]);
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
    expect(isTooltipDataset("timeout")).toBe(true);
    expect(isTooltipDataset("no_response")).toBe(true);
    expect(isTooltipDataset("203.165.31.152 min")).toBe(false);
    expect(isTooltipDataset("203.165.31.152 mean-σ")).toBe(false);

    vi.useRealTimers();
  });
});

describe("shouldShowLatencyPoints", () => {
  it("hides scatter points at 6h range and above", () => {
    expect(shouldShowLatencyPoints(3 * HOUR_SEC)).toBe(true);
    expect(shouldShowLatencyPoints(HIDE_LATENCY_POINTS_RANGE_SEC)).toBe(false);
    expect(shouldShowLatencyPoints(DAY_SEC)).toBe(false);
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
    expect(formatFailureLabel(points[0])).toBe("203.165.31.152 / amazon.co.jp: タイムアウト（旧）");
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

  it("sets y-axis max to p95 * 2 (consistent with computeStats), including when outliers exceed it", () => {
    // 20 low latencies + 1 high outlier.
    // n=21 → ceil(0.95 * 21) - 1 = 19 → p95 picks from the low values, max is the outlier.
    const lines: string[] = [];
    const baseTs = 1781967602;
    for (let i = 0; i < 20; i++) {
      lines.push(`${baseTs + i * 60}\t203.165.31.152\texample.com\t${100 + (i % 50)}`);
    }
    lines.push(`${baseTs + 2000}\t203.165.31.152\texample.com\t5000`);

    const records = parseTsv(lines.join("\n"));
    // Use records directly (bypass filterByPeriod which depends on current displayRangeSec + "now")
    // to ensure our crafted timestamps are included.
    const { successes, failures } = aggregateByServer(records);
    const stats = computeStats(records);

    buildLatencyChart(records, successes, failures, 0);

    const chart = getLatencyChart()!;
    expect(stats.p95).toBeGreaterThan(0);
    expect(stats.max).toBe(5000);
    const yMax = chart.options.scales?.y?.max;
    const expectedYMax = ceilingToHundred(stats.p95 * 2);
    expect(yMax).toBe(expectedYMax);
    expect(yMax).toBeLessThan(stats.max); // we force the cap below the actual max
    // also verify the live scale (after Chart construction) received the max
    expect(chart.scales?.y?.max).toBe(expectedYMax);
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

    const stats = computeStats(filtered);
    const yMax = chart?.options.scales?.y?.max;
    const expectedYMax = stats.p95 > 0 ? ceilingToHundred(stats.p95 * 2) : undefined;
    expect(yMax).toBe(expectedYMax);

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

    const chart = getLatencyChart();
    expect(chart?.options.scales?.y?.max).toBeUndefined();

    vi.useRealTimers();
  });
});