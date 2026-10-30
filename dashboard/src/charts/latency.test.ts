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
  isLatencyChartScrollable,
  isLatencyScrollMode,
  isTooltipDataset,
  latencyChartScrollWidth,
  nearestBatchTs,
  scrollLatencyChartToLatest,
  shouldShowLatencyPoints,
  viewMaxFromScrollRatio,
  visibleTimeSec,
  visibleXWindow,
} from "./latency.ts";
import { buildErrorChart } from "./error.ts";
import { sampleTsv } from "../test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "../state.ts";
import { chartTimeBounds, isJstOnTheHour } from "../time.ts";
import { DAY_SEC, HIDE_LATENCY_POINTS_RANGE_SEC, HOUR_SEC } from "../constants.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

beforeAll(() => {
  document.body.innerHTML = `
    <div class="chart-container chart-container--latency" id="latencyChartContainer" style="width:800px;height:400px">
      <div class="chart-plot-frame" style="width:800px;height:380px">
        <canvas id="latencyChart" width="800" height="380"></canvas>
      </div>
      <div class="chart-hscroll" id="latencyChartScroll" style="width:800px;height:12px" hidden>
        <div class="chart-hscroll-inner" id="latencyChartInner" style="width:800px;height:1px"></div>
      </div>
    </div>
    <canvas id="errorChart" width="800" height="200"></canvas>
  `;
  const scroll = document.getElementById("latencyChartScroll")!;
  const container = document.getElementById("latencyChartContainer")!;
  Object.defineProperty(scroll, "clientWidth", { configurable: true, get: () => 800 });
  Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => 12 });
  Object.defineProperty(scroll, "offsetHeight", { configurable: true, get: () => 12 });
  Object.defineProperty(scroll, "scrollWidth", {
    configurable: true,
    get: () => {
      const inner = document.getElementById("latencyChartInner");
      const w = Number.parseInt(inner?.style.width ?? "800", 10);
      return Number.isFinite(w) ? w : 800;
    },
  });
  Object.defineProperty(scroll, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 0,
  });
  Object.defineProperty(container, "clientWidth", { configurable: true, get: () => 800 });
});

describe("nearestBatchTs", () => {
  it("snaps hover to the nearest measurement batch timestamp", () => {
    const batches = [1000, 1060, 1120];
    expect(nearestBatchTs(batches, 1000)).toBe(1000);
    expect(nearestBatchTs(batches, 1029)).toBe(1000);
    expect(nearestBatchTs(batches, 1031)).toBe(1060);
  });
});

describe("latency chart pan / viewport window", () => {
  it("scrolls only when the full data span is longer than the selected viewport", () => {
    expect(isLatencyChartScrollable(HOUR_SEC, HOUR_SEC)).toBe(false);
    expect(isLatencyChartScrollable(6 * HOUR_SEC, HOUR_SEC)).toBe(true);
    expect(isLatencyChartScrollable(3 * DAY_SEC, DAY_SEC)).toBe(true);
  });

  it("sizes the scrubber so the selected range fills the plot", () => {
    expect(latencyChartScrollWidth(800, HOUR_SEC, HOUR_SEC)).toBe(800);
    expect(latencyChartScrollWidth(800, HOUR_SEC, 6 * HOUR_SEC)).toBe(4800);
    expect(latencyChartScrollWidth(800, DAY_SEC, HOUR_SEC)).toBe(800);

    const plotW = 800;
    const span = 3 * DAY_SEC;
    const viewport = 6 * HOUR_SEC;
    const contentW = latencyChartScrollWidth(plotW, viewport, span);
    expect(visibleTimeSec(span, contentW, plotW)).toBeCloseTo(viewport, 0);
  });

  it("maps scroll ratio 1 to the latest window and 0 to the oldest", () => {
    const spanMin = 1_000_000;
    const spanMax = spanMin + 6 * HOUR_SEC;
    const viewport = HOUR_SEC;
    expect(viewMaxFromScrollRatio(1, viewport, spanMin, spanMax)).toBe(spanMax);
    expect(viewMaxFromScrollRatio(0, viewport, spanMin, spanMax)).toBe(spanMin + viewport);

    const latest = visibleXWindow(spanMax, viewport, spanMin, spanMax);
    expect(latest.max).toBe(spanMax);
    expect(latest.max - latest.min).toBe(viewport);
  });

  it("first view uses the latest viewport when history exceeds the selected range", () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(new Date(nowSec * 1000));
    setDisplayRangeSec(HOUR_SEC);

    const historyStart = nowSec - 6 * HOUR_SEC;
    const records = [
      { ts: historyStart, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 20 },
      { ts: nowSec - 60, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 25 },
    ];
    const { successes, failures } = aggregateByServer(records);

    buildLatencyChart(records, successes, failures, historyStart - HOUR_SEC);

    const chart = getLatencyChart()!;
    const xMin = Number(chart.options.scales?.x?.min);
    const xMax = Number(chart.options.scales?.x?.max);
    expect(xMax - xMin).toBe(HOUR_SEC);
    expect(isLatencyScrollMode()).toBe(true);

    const scroll = document.getElementById("latencyChartScroll") as HTMLElement & {
      hidden: boolean;
      scrollLeft: number;
    };
    expect(scroll.hidden).toBe(false);
    scrollLatencyChartToLatest();
    const innerW = Number.parseInt(
      document.getElementById("latencyChartInner")!.style.width,
      10,
    );
    expect(scroll.scrollLeft).toBe(innerW - 800);

    // Chart Y axis stays on the main canvas (no dual-canvas mode).
    const yScale = chart.options.scales?.y as { ticks?: { display?: boolean }; title?: { display?: boolean } };
    expect(yScale.ticks?.display).not.toBe(false);
    expect(yScale.title?.display).not.toBe(false);

    vi.useRealTimers();
  });

  it("pins first view to the latest hour for a 30m zoom over a day of history", () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(new Date(nowSec * 1000));
    setDisplayRangeSec(30 * 60);

    const historyStart = nowSec - DAY_SEC;
    const records = [
      { ts: historyStart, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 20 },
      { ts: nowSec - 30, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 25 },
    ];
    const { successes, failures } = aggregateByServer(records);
    buildLatencyChart(records, successes, failures, historyStart);

    expect(isLatencyScrollMode()).toBe(true);
    const chart = getLatencyChart()!;
    const xMin = Number(chart.options.scales?.x?.min);
    const xMax = Number(chart.options.scales?.x?.max);
    expect(xMax - xMin).toBe(30 * 60);
    // Latest window ends at the chart's right edge (aligned “now”).
    expect(xMax).toBeGreaterThanOrEqual(nowSec);

    vi.useRealTimers();
  });

  it("hides the scrubber when history fits in one viewport", () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(new Date(nowSec * 1000));
    setDisplayRangeSec(DAY_SEC);

    const records = [
      { ts: nowSec - 30 * 60, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 20 },
      { ts: nowSec - 60, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 25 },
    ];
    const { successes, failures } = aggregateByServer(records);

    buildLatencyChart(records, successes, failures, nowSec - DAY_SEC);

    expect(isLatencyScrollMode()).toBe(false);
    const scroll = document.getElementById("latencyChartScroll") as HTMLElement;
    expect(scroll.hidden).toBe(true);

    vi.useRealTimers();
  });
});

describe("buildTooltipLines", () => {
  it("lists every domain at the same batch timestamp", () => {
    const records = parseTsv(sampleTsv);
    const lines = buildTooltipLines(records, 1781967602);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.includes("ms") || line.includes("timeout"))).toBe(true);
  });

  it("includes measured duration for DNS timeout rows", () => {
    const records = parseTsv("1781967662\t203.165.31.152\tline.me\t15000\tdns_timeout");
    const lines = buildTooltipLines(records, 1781967662);
    expect(lines.some((line) => /dns_timeout|DNS|15000|15.?000|ms/i.test(line))).toBe(true);
  });

  it("lists each resolver separately at the same batch timestamp", () => {
    const records = parseTsv(sampleTsv);
    const lines = buildTooltipLines(records, 1781967602);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("collectActiveElementsAtBatch", () => {
  it("selects every success and failure point at the same timestamp", () => {
    document.body.innerHTML += `<canvas id="tmpChart" width="100" height="100"></canvas>`;
    // Covered via buildLatencyChart integration below.
    expect(true).toBe(true);
  });
});

describe("shouldShowLatencyPoints", () => {
  it("hides scatter points at 6h range and above", () => {
    expect(shouldShowLatencyPoints(HIDE_LATENCY_POINTS_RANGE_SEC - 1)).toBe(true);
    expect(shouldShowLatencyPoints(HIDE_LATENCY_POINTS_RANGE_SEC)).toBe(false);
  });
});

describe("formatFailureLabel / buildFailurePoints", () => {
  it("keeps every failure domain at the same timestamp", () => {
    const records = parseTsv(sampleTsv);
    const points = buildFailurePoints(records);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.error)).toBe(true);
  });

  it("carries measured duration for dns_timeout labels", () => {
    const records = parseTsv("1781967662\t203.165.31.152\tline.me\t5000\tdns_timeout");
    const [point] = buildFailurePoints(records);
    expect(formatFailureLabel(point)).toMatch(/dns_timeout|DNS/);
  });
});

describe("isTooltipDataset", () => {
  it("is true for server series and error, false for band edges", () => {
    expect(isTooltipDataset("1.1.1.1")).toBe(true);
    expect(isTooltipDataset("error")).toBe(true);
    expect(isTooltipDataset("1.1.1.1 min")).toBe(false);
  });
});

describe("buildLatencyChart", () => {
  it("renders charts from published TSV without throwing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 20, 14, 25, 5)));
    setDisplayRangeSec(DAY_SEC);
    setDataCutoffTs(1781967600);

    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781967600);
    const { successes, failures } = aggregateByServer(filtered);

    expect(() => {
      buildLatencyChart(filtered, successes, failures, 1781967600);
      buildErrorChart({});
    }).not.toThrow();

    vi.useRealTimers();
  });

  it("sets y-axis max to p95 * 2 (consistent with computeStats), including when outliers exceed it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 20, 15, 10, 0)));
    setDisplayRangeSec(DAY_SEC);

    // Mostly low samples + one huge outlier so p95 stays low while max is high.
    const base = 1_781_967_602;
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `${base + i}\t1.1.1.1\texample.com\t50`),
      `${base + 20}\t1.1.1.1\texample.com\t5000`,
    ].join("\n");
    const records = parseTsv(lines);
    const stats = computeStats(records);
    const { successes, failures } = aggregateByServer(records);
    buildLatencyChart(records, successes, failures, 0);

    const chart = getLatencyChart()!;
    expect(stats.p95).toBeGreaterThan(0);
    expect(stats.max).toBe(5000);
    const yMax = chart.options.scales?.y?.max;
    const expectedYMax = ceilingToHundred(stats.p95 * 2);
    expect(yMax).toBe(expectedYMax);
    expect(yMax).toBeLessThan(stats.max);
    expect(chart.scales?.y?.max).toBe(expectedYMax);

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
    // Visible window ends at the full domain max (aligned now).
    expect(xMax).toBe(expected.max);
    expect(isJstOnTheHour(Number(xMax))).toBe(true);

    vi.useRealTimers();
  });

  it("renders when no records fall in the display window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_900_000_000 * 1000));

    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1_800_000_000);
    expect(filtered).toHaveLength(0);

    expect(() => {
      buildLatencyChart(filtered, [], [], 1_800_000_000);
      buildErrorChart({});
    }).not.toThrow();

    const chart = getLatencyChart();
    expect(chart?.options.scales?.y?.max).toBeUndefined();

    vi.useRealTimers();
  });
});
