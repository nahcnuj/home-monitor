import {
  Chart,
  type ChartConfiguration,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import {
  HIDE_LATENCY_POINTS_RANGE_SEC,
  MAX_GAP_SEC,
  SCROLLABLE_CHART_Y_AXIS_WIDTH_PX,
  SERVER_COLORS,
} from "../constants.ts";
import { formatErrorCode, isDnsErrorCode } from "../errors.ts";
import { ceilingToHundred, percentile } from "../data.ts";
import { displayRangeSec } from "../state.ts";
import { buildRollingEnvelope, collectTimelineTimestamps } from "./rolling-envelope.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst, isCompactChartLayout } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
  LatencySamplePoint,
} from "../types.ts";
import { minOf, timeoutRanges, withAlpha, withGaps } from "../utils.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

function listFailures(records: DnsRecord[]): DnsFailureRecord[] {
  return records.filter((r): r is DnsFailureRecord => Boolean(r.error));
}

export function buildFailurePoints(records: DnsRecord[]): FailurePoint[] {
  return listFailures(records).map((r) => ({
    x: r.ts,
    y: 0,
    error: r.error,
    dns_server: r.dns_server,
    domain: r.domain,
    duration_ms: r.duration_ms,
  }));
}

export function formatFailureLabel(point: FailurePoint): string {
  const domain = point.domain ? ` / ${point.domain}` : "";
  const base = `${point.dns_server}${domain}: ${formatErrorCode(point.error)}`;
  if (point.duration_ms != null && point.duration_ms > 0) {
    return `${base} (${Math.round(point.duration_ms)} ms)`;
  }
  return base;
}

export function formatSuccessLabel(
  dnsServer: string,
  domain: string | null,
  latencyMs: number,
): string {
  const target = domain ? ` / ${domain}` : "";
  return `${dnsServer}${target}: ${Math.round(latencyMs)} ms`;
}

export function collectBatchTimestamps(records: DnsRecord[]): number[] {
  return [...new Set(records.map((r) => r.ts))].sort((a, b) => a - b);
}

export function nearestBatchTs(batchTimestamps: readonly number[], hoverValue: number): number | null {
  if (!batchTimestamps.length) return null;

  let best = batchTimestamps[0];
  let bestDist = Math.abs(best - hoverValue);
  for (let i = 1; i < batchTimestamps.length; i++) {
    const ts = batchTimestamps[i];
    const dist = Math.abs(ts - hoverValue);
    if (dist < bestDist) {
      best = ts;
      bestDist = dist;
    }
  }
  return best;
}

function compareDomain(a: string | null, b: string | null): number {
  return (a ?? "").localeCompare(b ?? "");
}

export function buildTooltipLines(records: DnsRecord[], ts: number): string[] {
  const batch = records.filter((r) => r.ts === ts);
  const lines: string[] = [];

  for (const record of batch.filter(isSuccess).sort((a, b) => {
    const byServer = a.dns_server.localeCompare(b.dns_server);
    return byServer !== 0 ? byServer : compareDomain(a.domain, b.domain);
  })) {
    lines.push(formatSuccessLabel(record.dns_server, record.domain, record.latency_ms));
  }

  for (const record of listFailures(batch).sort((a, b) => compareDomain(a.domain, b.domain))) {
    lines.push(formatFailureLabel({
      x: record.ts,
      y: 0,
      error: record.error,
      dns_server: record.dns_server,
      domain: record.domain,
      duration_ms: record.duration_ms,
    }));
  }

  return lines;
}

export function resolveTooltipBatchTsFromPixel(
  chart: Chart,
  batchTimestamps: readonly number[],
  pixelX: number,
): number | null {
  const scale = chart.scales.x;
  if (!scale) return null;

  const hoverValue = scale.getValueForPixel(pixelX);
  if (hoverValue == null || Number.isNaN(Number(hoverValue))) return null;

  return nearestBatchTs(batchTimestamps, Number(hoverValue));
}

export function isFailureDataset(label: string | undefined): boolean {
  return label === "error" || isDnsErrorCode(label);
}

export function isTooltipDataset(label: string | undefined): boolean {
  return !!label && !isHiddenBand(label);
}

function pointTimestamp(point: unknown): number | null {
  if (typeof point !== "object" || point === null || !("x" in point)) return null;
  const x = point.x;
  if (typeof x !== "number" || Number.isNaN(x)) return null;
  return Math.round(x);
}

export function collectActiveElementsAtBatch(
  chart: Chart,
  ts: number,
): { datasetIndex: number; index: number }[] {
  const active: { datasetIndex: number; index: number }[] = [];

  chart.data.datasets.forEach((dataset, datasetIndex) => {
    if (!isTooltipDataset(dataset.label)) return;

    dataset.data.forEach((point, index) => {
      if (pointTimestamp(point) === ts) {
        active.push({ datasetIndex, index });
      }
    });
  });

  return active;
}

function applyBatchTooltip(
  chart: Chart,
  batchTimestamps: readonly number[],
  pixelX: number,
  pixelY: number,
): { datasetIndex: number; index: number }[] | null {
  const ts = resolveTooltipBatchTsFromPixel(chart, batchTimestamps, pixelX);
  if (ts == null) return null;

  const active = collectActiveElementsAtBatch(chart, ts);
  if (!active.length) return null;

  chart.setActiveElements(active);
  chart.tooltip?.setActiveElements(active, { x: pixelX, y: pixelY });
  return active;
}

function createBatchTooltipPlugin(batchTimestamps: readonly number[]): Plugin<"line"> {
  let lastKey = "";

  return {
    id: "batchTooltip",
    afterEvent(chart, args) {
      const event = args.event;
      if (event.type === "mouseout" || !args.inChartArea) {
        lastKey = "";
        chart.setActiveElements([]);
        return;
      }
      if (event.type !== "mousemove") return;

      const pixelX = event.x;
      const pixelY = event.y;
      if (pixelX == null || pixelY == null) return;

      const active = applyBatchTooltip(chart, batchTimestamps, pixelX, pixelY);
      if (!active) return;

      const key = active.map((item) => `${item.datasetIndex}:${item.index}`).join(",");
      if (key === lastKey) return;
      lastKey = key;

      args.changed = true;
    },
  };
}

const BAND_TENSION = 0.42;
const SIGMA_BAND_ALPHA = 0.18;
const SIGMA_BAND_ALPHA_LONG = 0.32;
const MINMAX_BAND_ALPHA = 0.07;
const MINMAX_BAND_ALPHA_LONG = 0.12;
const TIMEOUT_EDGE_WIDTH = 2;

export function shouldShowLatencyPoints(rangeSec: number = displayRangeSec): boolean {
  return rangeSec < HIDE_LATENCY_POINTS_RANGE_SEC;
}

const DEFAULT_VIEWPORT_SEC = 24 * 3600;

let latencyChart: Chart | null = null;
/** Whether the last layout pass put the latency chart in horizontal-scroll mode. */
let latencyScrollMode = false;
/** Full X span (sec) and selected viewport duration for width = container * span / viewport. */
let latencyChartSpanSec = 0;
let latencyChartViewportSec = DEFAULT_VIEWPORT_SEC;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

/**
 * CSS width of the scrollable plot so that `viewportSec` of time fills the container width.
 * When history is longer than the selected range, the chart becomes wider and scrolls.
 *
 * visibleTime ≈ spanSec * (containerWidth / result) ⇒ equals viewportSec when span > viewport.
 */
export function latencyChartScrollWidth(
  containerWidth: number,
  viewportSec: number,
  spanSec: number,
): number {
  if (containerWidth <= 0) return 0;
  if (viewportSec <= 0 || spanSec <= viewportSec) return containerWidth;
  return Math.max(containerWidth, Math.ceil(containerWidth * (spanSec / viewportSec)));
}

/** Seconds of X-domain visible in a plot of `visiblePx` out of `contentPx` width. */
export function visibleTimeSec(spanSec: number, contentPx: number, visiblePx: number): number {
  if (contentPx <= 0 || visiblePx <= 0 || spanSec <= 0) return 0;
  return spanSec * (visiblePx / contentPx);
}

export function setLatencyChartGeometry(spanSec: number, viewportSec: number): void {
  latencyChartSpanSec = Math.max(0, spanSec);
  latencyChartViewportSec = Math.max(1, viewportSec);
}

/** True when the full data span is longer than one viewport (selected range). */
export function isLatencyChartScrollable(
  spanSec: number = latencyChartSpanSec,
  viewportSec: number = latencyChartViewportSec,
): boolean {
  return spanSec > viewportSec + 1;
}

/** Last applied plot pixel size (scroll mode); used for explicit Chart.resize. */
let latencyPlotCssWidth = 0;
let latencyPlotCssHeight = 0;

function resetLatencyPlotCssSize(): void {
  latencyPlotCssWidth = 0;
  latencyPlotCssHeight = 0;
  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  const { inner } = getLatencyLayoutElements();
  if (inner) {
    inner.style.width = "100%";
    inner.style.height = "";
  }
  if (canvas) {
    canvas.style.width = "";
    canvas.style.height = "";
  }
}

/**
 * Force the plot box to an explicit CSS size. Chart.js responsive mode sizes from the
 * parent; with overflow scrolling it often collapses to the viewport and the selected
 * range no longer maps to “one screen of time” — so scroll mode uses fixed pixels.
 */
function applyLatencyPlotCssSize(contentW: number, height: number): void {
  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  const { inner } = getLatencyLayoutElements();
  latencyPlotCssWidth = contentW;
  latencyPlotCssHeight = height;
  if (inner) {
    inner.style.width = `${contentW}px`;
    inner.style.height = `${height}px`;
  }
  if (canvas) {
    canvas.style.width = `${contentW}px`;
    canvas.style.height = `${height}px`;
  }
}

export function resizeLatencyChartToPlot(): void {
  if (!latencyChart) return;
  if (latencyScrollMode && latencyPlotCssWidth > 0 && latencyPlotCssHeight > 0) {
    latencyChart.resize(latencyPlotCssWidth, latencyPlotCssHeight);
  } else {
    latencyChart.resize();
  }
}

function getLatencyLayoutElements(): {
  container: HTMLElement | null;
  yAxisWrap: HTMLElement | null;
  scroll: HTMLElement | null;
  inner: HTMLElement | null;
  yAxisCanvas: HTMLCanvasElement | null;
  legend: HTMLElement | null;
} {
  return {
    container: document.getElementById("latencyChartContainer"),
    yAxisWrap: document.getElementById("latencyYAxisWrap"),
    scroll: document.getElementById("latencyChartScroll"),
    inner: document.getElementById("latencyChartInner"),
    yAxisCanvas: document.getElementById("latencyYAxis") as HTMLCanvasElement | null,
    legend: document.getElementById("latencyLegend"),
  };
}

/**
 * Size the plot area and toggle fixed Y-axis / scroll mode.
 * Selected range = time shown across the visible width; extra history scrolls left.
 * Default scroll position is the right edge (most recent data).
 */
export function applyLatencyChartLayout(scrollToEnd = false): boolean {
  const { container, yAxisWrap, scroll, inner } = getLatencyLayoutElements();
  if (!container || !scroll || !inner) {
    latencyScrollMode = false;
    resetLatencyPlotCssSize();
    return false;
  }

  // Measure without the Y-axis column first.
  if (yAxisWrap) {
    yAxisWrap.hidden = true;
    yAxisWrap.style.paddingBottom = "";
    yAxisWrap.style.height = "";
    yAxisWrap.style.alignSelf = "";
  }
  container.classList.remove("is-scrollable");
  resetLatencyPlotCssSize();

  // Prefer the container’s content box; fall back if the scrollport is not laid out yet.
  const baseW = scroll.clientWidth || container.clientWidth;
  if (baseW <= 0 || !isLatencyChartScrollable()) {
    scroll.scrollLeft = 0;
    latencyScrollMode = false;
    return false;
  }

  let contentW = latencyChartScrollWidth(baseW, latencyChartViewportSec, latencyChartSpanSec);
  let needsScroll = contentW > baseW + 1;

  if (needsScroll) {
    if (yAxisWrap) {
      yAxisWrap.hidden = false;
      yAxisWrap.style.flexBasis = `${SCROLLABLE_CHART_Y_AXIS_WIDTH_PX}px`;
      yAxisWrap.style.width = `${SCROLLABLE_CHART_Y_AXIS_WIDTH_PX}px`;
    }
    container.classList.add("is-scrollable");
    const plotW = scroll.clientWidth || Math.max(1, baseW - SCROLLABLE_CHART_Y_AXIS_WIDTH_PX);
    contentW = latencyChartScrollWidth(plotW, latencyChartViewportSec, latencyChartSpanSec);
    // If showing the axis made the plot fit, fall back to a normal chart.
    if (contentW <= plotW + 1) {
      if (yAxisWrap) {
        yAxisWrap.hidden = true;
        yAxisWrap.style.height = "";
        yAxisWrap.style.alignSelf = "";
      }
      container.classList.remove("is-scrollable");
      resetLatencyPlotCssSize();
      scroll.scrollLeft = 0;
      latencyScrollMode = false;
      return false;
    }

    const plotH = Math.max(1, scroll.clientHeight || container.clientHeight);
    applyLatencyPlotCssSize(contentW, plotH);

    // Match axis height to the plot above the horizontal scrollbar (not the full card).
    if (yAxisWrap) {
      yAxisWrap.style.paddingBottom = "";
      yAxisWrap.style.height = `${plotH}px`;
      yAxisWrap.style.alignSelf = "flex-start";
    }
    if (scrollToEnd) {
      // After width change, scrollWidth may not update until layout; use computed sizes.
      scroll.scrollLeft = Math.max(0, contentW - plotW);
    }
    latencyScrollMode = true;
    return true;
  }

  if (yAxisWrap) {
    yAxisWrap.hidden = true;
    yAxisWrap.style.height = "";
    yAxisWrap.style.alignSelf = "";
  }
  resetLatencyPlotCssSize();
  scroll.scrollLeft = 0;
  latencyScrollMode = false;
  return false;
}

export function isLatencyScrollMode(): boolean {
  return latencyScrollMode;
}

function clearLatencyLegend(): void {
  const { legend } = getLatencyLayoutElements();
  if (!legend) return;
  legend.hidden = true;
  legend.innerHTML = "";
}

function renderLatencyLegend(servers: readonly string[]): void {
  const { legend } = getLatencyLayoutElements();
  if (!legend) return;
  if (!latencyScrollMode || !servers.length) {
    clearLatencyLegend();
    return;
  }
  legend.hidden = false;
  legend.innerHTML = servers
    .map((server, index) => {
      const color = SERVER_COLORS[index % SERVER_COLORS.length];
      return `<span class="latency-legend-item"><span class="swatch" style="background:${color}"></span>${server}</span>`;
    })
    .join("");
}

/** Draw fixed Y-axis labels aligned to the main chart's Y scale. */
export function paintLatencyYAxis(): void {
  const { yAxisWrap, yAxisCanvas } = getLatencyLayoutElements();
  if (!latencyChart || !yAxisWrap || !yAxisCanvas || yAxisWrap.hidden || !latencyScrollMode) {
    return;
  }

  const scale = latencyChart.scales.y;
  if (!scale) return;

  const cssW = SCROLLABLE_CHART_Y_AXIS_WIDTH_PX;
  const cssH = yAxisWrap.clientHeight;
  if (cssH <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  yAxisCanvas.width = Math.max(1, Math.floor(cssW * dpr));
  yAxisCanvas.height = Math.max(1, Math.floor(cssH * dpr));
  yAxisCanvas.style.width = `${cssW}px`;
  yAxisCanvas.style.height = `${cssH}px`;

  const ctx = yAxisCanvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.strokeStyle = "#2a2e3d";
  ctx.fillStyle = "#8b90a0";
  ctx.lineWidth = 1;

  // Axis line on the right edge (adjacent to the plot).
  ctx.beginPath();
  ctx.moveTo(cssW - 0.5, scale.top);
  ctx.lineTo(cssW - 0.5, scale.bottom);
  ctx.stroke();

  ctx.font = `11px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  scale.ticks.forEach((tick, index) => {
    const y = scale.getPixelForTick(index);
    if (y < scale.top - 4 || y > scale.bottom + 4) return;
    // Tick mark
    ctx.beginPath();
    ctx.moveTo(cssW - 0.5, y);
    ctx.lineTo(cssW - 5, y);
    ctx.stroke();
    const raw = tick.label ?? tick.value;
    const text = Array.isArray(raw) ? raw.join(" ") : String(raw);
    ctx.fillText(text, cssW - 7, y);
  });

  // Rotated unit label
  ctx.save();
  ctx.translate(11, (scale.top + scale.bottom) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("ms", 0, 0);
  ctx.restore();
}

/** Call after window resize or container size changes. */
export function resizeLatencyChartLayout(): void {
  applyLatencyChartLayout(false);
  resizeLatencyChartToPlot();
  if (latencyScrollMode) {
    paintLatencyYAxis();
  }
}

function isHiddenBand(label: string | undefined): boolean {
  return !!label?.endsWith(" min")
    || !!label?.endsWith(" max")
    || !!label?.endsWith(" mean-σ")
    || !!label?.endsWith(" mean+σ");
}

export function latencyTooltipTitle(items: TooltipItem<"line">[]): string {
  const raw = items[0]?.raw as { x?: number } | null;
  const x = raw?.x ?? items[0]?.parsed?.x;
  return x == null || Number.isNaN(Number(x)) ? "" : fmtJst(Number(x));
}

function latencyTooltipLabel(ctx: TooltipItem<"line">): string {
  const raw = ctx.raw as FailurePoint | LatencySamplePoint | null;
  if (!raw || typeof raw !== "object") return "";
  if ("error" in raw && raw.error) {
    return formatFailureLabel(raw);
  }
  const dnsServer = ctx.dataset.label;
  if (dnsServer && !isDnsErrorCode(dnsServer)) {
    return formatSuccessLabel(dnsServer, raw.domain ?? null, raw.y);
  }
  return formatSuccessLabel("unknown", raw.domain ?? null, raw.y);
}

export function buildLatencyChart(
  rawRecords: DnsRecord[],
  _successes: AggregatedSuccess[],
  _failures: DnsFailureRecord[],
  dataCutoffTs: number,
): void {
  const allFailures = listFailures(rawRecords);
  const batchTimestamps = collectBatchTimestamps(rawRecords);

  const successesForP95 = rawRecords.filter(isSuccess);
  const latencies = successesForP95.map((r) => r.latency_ms);
  const p95 = percentile(latencies, 95);
  const yMax = p95 > 0 ? ceilingToHundred(p95 * 2) : undefined;

  const compact = isCompactChartLayout();
  // Loop min — Math.min(...ts) overflows the stack on multi-day datasets.
  const dataMinTs = rawRecords.length ? minOf(rawRecords.map((r) => r.ts)) : undefined;
  const xBounds = chartTimeBounds(undefined, compact, {
    dataMinTs,
    dataCutoffTs,
  });
  setLatencyChartGeometry(xBounds.range, xBounds.viewportSec);
  const { timestamps, step } = collectTimelineTimestamps(rawRecords, xBounds.min, xBounds.max);
  const maxGapSec = Math.max(MAX_GAP_SEC, MAX_GAP_SEC * step);
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];
  const showPoints = shouldShowLatencyPoints();
  const sigmaBandAlpha = showPoints ? SIGMA_BAND_ALPHA : SIGMA_BAND_ALPHA_LONG;
  const minMaxBandAlpha = showPoints ? MINMAX_BAND_ALPHA : MINMAX_BAND_ALPHA_LONG;

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const envelope = buildRollingEnvelope(rawRecords, server, timestamps);

    datasets.push({
      label: `${server} max`,
      order: 3,
      data: withGaps(envelope.max, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: "transparent",
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: false,
      spanGaps: false,
    });
    datasets.push({
      label: `${server} min`,
      order: 3,
      data: withGaps(envelope.min, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: withAlpha(color, minMaxBandAlpha),
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: "-1",
      spanGaps: false,
    });
    datasets.push({
      label: `${server} mean+σ`,
      order: 3,
      data: withGaps(envelope.meanHigh, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: "transparent",
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: false,
      spanGaps: false,
    });
    datasets.push({
      label: `${server} mean-σ`,
      order: 3,
      data: withGaps(envelope.meanLow, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: withAlpha(color, sigmaBandAlpha),
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: "-1",
      spanGaps: false,
    });

    const samples = rawRecords.filter(
      (r): r is DnsSuccessRecord => isSuccess(r) && r.dns_server === server,
    );
    if (samples.length) {
      datasets.push({
        label: server,
        type: "scatter",
        order: 1,
        data: samples.map((r): LatencySamplePoint => ({
          x: r.ts,
          y: r.latency_ms,
          domain: r.domain,
        })),
        borderColor: color,
        backgroundColor: withAlpha(color, 0.85),
        pointRadius: showPoints ? 1.25 : 0,
        pointHoverRadius: showPoints ? 2.5 : 0,
        showLine: false,
      });
    }
  });

  // Invisible scatter only so batch tooltips can still list failures; visuals are red bars (chartRegions).
  const failurePoints = buildFailurePoints(rawRecords);
  if (failurePoints.length) {
    datasets.push({
      label: "error",
      type: "scatter",
      order: 0,
      data: failurePoints,
      borderColor: "transparent",
      backgroundColor: "transparent",
      pointRadius: 0,
      pointHoverRadius: 0,
      showLine: false,
    });
  }

  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  if (!canvas) return;

  // Decide scroll mode + explicit plot size before Chart construction.
  const scrollable = applyLatencyChartLayout(false);
  renderLatencyLegend(scrollable ? servers : []);

  latencyChart?.destroy();

  const config = {
    type: "line",
    plugins: [createBatchTooltipPlugin(batchTimestamps)],
    data: { datasets },
    options: {
      // Scroll mode: fixed pixel size so the selected range maps to one screen of time.
      // Responsive mode collapses to the overflow viewport and shows the whole history at once.
      responsive: !scrollable,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      // Extra top padding when Chart.js legend is hidden (external legend is above the container).
      layout: scrollable ? { padding: { top: 4 } } : undefined,
      scales: {
        x: {
          type: "linear",
          min: xBounds.min,
          max: xBounds.max,
          grid: { color: "#2a2e3d" },
          ticks: {
            color: "#8b90a0",
            stepSize: xBounds.tickStep,
            // Long history + fine viewport steps would mint thousands of labels; skip by pixel density.
            autoSkip: true,
            maxRotation: 0,
            maxTicksLimit: compact ? 6 : 16,
            font: compact ? { size: 10 } : undefined,
            callback: (value: string | number) =>
              fmtAxisTick(Number(value), xBounds.tickStep, compact),
          },
        },
        y: {
          title: {
            display: !scrollable,
            text: "ms",
            color: "#8b90a0",
          },
          grid: { color: "#2a2e3d" },
          border: { display: !scrollable },
          ticks: {
            display: !scrollable,
            color: "#8b90a0",
          },
          min: 0,
          ...(yMax != null ? { max: yMax } : {}),
        },
      },
      plugins: {
        chartRegions: {
          xMin: xBounds.min,
          cutoffEnd: dataCutoffTs > xBounds.min ? dataCutoffTs : 0,
          timeoutRanges: timeoutRanges(allFailures),
          timeoutEdgeWidth: showPoints ? TIMEOUT_EDGE_WIDTH : 0,
          minTimeoutBarWidth: 1, // CSS px; short errors (e.g. 170ms no_response) stay visible
        },
        legend: {
          // Scroll mode: fixed HTML legend above the chart so labels do not slide away.
          display: !scrollable,
          labels: {
            color: "#e4e6ed",
            filter: (item: { text: string }) => !isHiddenBand(item.text) && !isFailureDataset(item.text),
          },
        },
        tooltip: {
          filter: (item: TooltipItem<"line">) => isTooltipDataset(item.dataset.label),
          itemSort: (a: TooltipItem<"line">, b: TooltipItem<"line">) => {
            const aFail = isFailureDataset(a.dataset.label);
            const bFail = isFailureDataset(b.dataset.label);
            if (aFail !== bFail) return aFail ? 1 : -1;
            return String(a.label).localeCompare(String(b.label));
          },
          callbacks: {
            title: latencyTooltipTitle,
            label: latencyTooltipLabel,
          },
        },
      },
    },
  };
  latencyChart = new Chart(canvas, config as ChartConfiguration);

  if (scrollable) {
    // Pin size + scroll to the latest viewport; paint the fixed Y-axis after scales exist.
    resizeLatencyChartToPlot();
    requestAnimationFrame(() => {
      applyLatencyChartLayout(true);
      resizeLatencyChartToPlot();
      paintLatencyYAxis();
    });
  } else {
    clearLatencyLegend();
  }
}