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
  shouldShowLatencyPoints,
  visibleTimeSec,
} from "./latency.ts";
import { buildErrorChart } from "./error.ts";
import { sampleTsv } from "../test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "../state.ts";
import { chartTimeBounds, isJstOnTheHour } from "../time.ts";
import { DAY_SEC, HIDE_LATENCY_POINTS_RANGE_SEC, HOUR_SEC } from "../constants.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

beforeAll(() => {
  document.body.innerHTML = `
    <div class="latency-legend" id="latencyLegend" hidden></div>
    <div class="chart-container chart-container--latency" id="latencyChartContainer" style="width:800px;height:400px">
      <div class="chart-yaxis-wrap" id="latencyYAxisWrap" hidden style="width:44px;height:400px">
        <canvas id="latencyYAxis" width="44" height="400"></canvas>
      </div>
      <div class="chart-scroll" id="latencyChartScroll" style="width:756px;height:400px">
        <div class="chart-scroll-inner" id="latencyChartInner" style="width:800px;height:400px">
          <canvas id="latencyChart" width="800" height="400"></canvas>
        </div>
      </div>
    </div>
    <canvas id="errorChart" width="800" height="200"></canvas>
  `;
  // jsdom: clientWidth/Height are 0 unless explicitly stubbed for layout helpers.
  const scroll = document.getElementById("latencyChartScroll")!;
  const container = document.getElementById("latencyChartContainer")!;
  Object.defineProperty(scroll, "clientWidth", { configurable: true, get: () => 756 });
  Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(scroll, "offsetHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(scroll, "scrollWidth", {
    configurable: true,
    get: () => {
      const inner = document.getElementById("latencyChartInner");
      const w = Number.parseInt(inner?.style.width ?? "756", 10);
      return Number.isFinite(w) ? w : 756;
    },
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

describe("latency chart horizontal scroll layout", () => {
  it("scrolls only when the full data span is longer than the selected viewport", () => {
    expect(isLatencyChartScrollable(HOUR_SEC, HOUR_SEC)).toBe(false);
    expect(isLatencyChartScrollable(6 * HOUR_SEC, HOUR_SEC)).toBe(true);
    expect(isLatencyChartScrollable(3 * DAY_SEC, DAY_SEC)).toBe(true);
  });

  it("sizes chart width so the selected range fills the container", () => {
    // span == viewport → fit to container
    expect(latencyChartScrollWidth(800, HOUR_SEC, HOUR_SEC)).toBe(800);
    // 6h of data at 1h viewport → 6× width
    expect(latencyChartScrollWidth(800, HOUR_SEC, 6 * HOUR_SEC)).toBe(4800);
    // span shorter than viewport → still container width
    expect(latencyChartScrollWidth(800, DAY_SEC, HOUR_SEC)).toBe(800);

    // 6h selected with multi-day history → one screen shows ~6h
    const plotW = 800;
    const span = 3 * DAY_SEC;
    const viewport = 6 * HOUR_SEC;
    const contentW = latencyChartScrollWidth(plotW, viewport, span);
    expect(visibleTimeSec(span, contentW, plotW)).toBeCloseTo(viewport, 0);
  });

  it("enables scroll mode with fixed Y-axis when history exceeds the selected range", () => {
    vi.useFakeTimers();
    // “Now” is well after the history start so a 1h viewport leaves older data off-screen.
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
    expect(xMax - xMin).toBeGreaterThan(HOUR_SEC);

    expect(isLatencyScrollMode()).toBe(true);
    const container = document.getElementById("latencyChartContainer");
    const yAxisWrap = document.getElementById("latencyYAxisWrap") as HTMLElement;
    const legend = document.getElementById("latencyLegend") as HTMLElement;
    expect(container?.classList.contains("is-scrollable")).toBe(true);
    expect(yAxisWrap.hidden).toBe(false);
    expect(legend.hidden).toBe(false);
    expect(legend.querySelectorAll(".latency-legend-item").length).toBeGreaterThan(0);

    const yScale = chart.options.scales?.y as { ticks?: { display?: boolean }; title?: { display?: boolean } };
    expect(yScale.ticks?.display).toBe(false);
    expect(yScale.title?.display).toBe(false);
    expect(chart.options.plugins?.legend?.display).toBe(false);
    expect(chart.options.responsive).toBe(false);

    const inner = document.getElementById("latencyChartInner")!;
    const contentW = Number.parseInt(inner.style.width, 10);
    expect(contentW).toBeGreaterThan(756);
    // Visible plot width is ~756px; width ratio must map ~1h on screen.
    expect(visibleTimeSec(xMax - xMin, contentW, 756)).toBeCloseTo(HOUR_SEC, 0);

    vi.useRealTimers();
  });

  it("keeps a normal integrated Y-axis when history fits in one viewport", () => {
    vi.useFakeTimers();
    const nowSec = 1_800_000_000;
    vi.setSystemTime(new Date(nowSec * 1000));
    setDisplayRangeSec(DAY_SEC);

    // Only 30 minutes of data — shorter than the 24h viewport → no scroll.
    const records = [
      { ts: nowSec - 30 * 60, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 20 },
      { ts: nowSec - 60, dns_server: "1.1.1.1", domain: "example.com", latency_ms: 25 },
    ];
    const { successes, failures } = aggregateByServer(records);

    buildLatencyChart(records, successes, failures, nowSec - DAY_SEC);

    expect(isLatencyScrollMode()).toBe(false);
    const yAxisWrap = document.getElementById("latencyYAxisWrap") as HTMLElement;
    expect(yAxisWrap.hidden).toBe(true);

    const chart = getLatencyChart()!;
    const yScale = chart.options.scales?.y as { ticks?: { display?: boolean }; title?: { display?: boolean } };
    expect(yScale.ticks?.display).not.toBe(false);
    expect(yScale.title?.display).not.toBe(false);
    expect(chart.options.plugins?.legend?.display).not.toBe(false);

    vi.useRealTimers();
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

  it("includes measured duration for DNS timeout rows", () => {
    const records = parseTsv([
      "1782003423\t203.165.31.152\tgoogle.com\t4218\tdns_timeout",
      "1782003423\t203.165.31.152\tline.me\t188",
    ].join("\n"));

    expect(buildTooltipLines(records, 1782003423)).toEqual([
      "203.165.31.152 / line.me: 188 ms",
      "203.165.31.152 / google.com: DNSタイムアウト (4218 ms)",
    ]);
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
    expect(isTooltipDataset("error")).toBe(true);
    expect(isTooltipDataset("timeout")).toBe(true);
    expect(isTooltipDataset("203.165.31.152 min")).toBe(false);
    expect(isTooltipDataset("203.165.31.152 mean-σ")).toBe(false);

    // Failures are one invisible series (bars are drawn by chartRegions).
    const failDs = chart!.data.datasets.filter((d) => d.label === "error");
    expect(failDs).toHaveLength(1);
    expect(failDs[0].data).toHaveLength(5);
    expect((failDs[0] as { pointRadius?: number }).pointRadius).toBe(0);

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

  it("carries measured duration for dns_timeout labels", () => {
    const records = parseTsv("1782003423\t203.165.31.152\tgoogle.com\t6158\tdns_timeout");
    const points = buildFailurePoints(records);
    expect(points).toEqual([{
      x: 1782003423,
      y: 0,
      error: "dns_timeout",
      dns_server: "203.165.31.152",
      domain: "google.com",
      duration_ms: 6158,
    }]);
    expect(formatFailureLabel(points[0])).toBe("203.165.31.152 / google.com: DNSタイムアウト (6158 ms)");
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
    vi.setSystemTime(new Date(1_900_000_000 * 1000));

    // Cutoff after all sample rows → empty chart data (history is not trimmed by range).
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