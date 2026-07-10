import {
  Chart,
  type ChartConfiguration,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import {
  HIDE_LATENCY_POINTS_RANGE_SEC,
  MAX_GAP_SEC,
  SERVER_COLORS,
} from "../constants.ts";
import { formatErrorCode, isDnsErrorCode } from "../errors.ts";
import { ceilingToHundred, percentile } from "../data.ts";
import { displayRangeSec } from "../state.ts";
import { buildRollingEnvelope, collectTimelineTimestamps } from "./rolling-envelope.ts";
import {
  chartTickStep,
  chartTimeBounds,
  fmtAxisTick,
  fmtJst,
  isCompactChartLayout,
} from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
  LatencySamplePoint,
  TimeBounds,
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
/** History longer than the selected range → show scrollbar and pan X domain. */
let latencyScrollMode = false;
/** Full history domain on the X axis (data/cutoff … aligned now). */
let latencySpanMin = 0;
let latencySpanMax = 0;
/** Selected range: seconds shown across the plot width. */
let latencyChartViewportSec = DEFAULT_VIEWPORT_SEC;
/** Right edge of the visible window (unix sec). First view = span max (latest). */
let latencyViewMax = 0;
let latencyScrollListenerBound = false;
let latencyScrollRaf = 0;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

/**
 * Spacer width for the history scrollbar so the thumb size reflects viewport / span.
 * (Native scrollbar thumb ≈ clientWidth² / scrollWidth when content width is this value.)
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

/** Visible time for a pan window (always the selected range when history is longer). */
export function visibleTimeSec(spanSec: number, contentPx: number, visiblePx: number): number {
  if (contentPx <= 0 || visiblePx <= 0 || spanSec <= 0) return 0;
  return spanSec * (visiblePx / contentPx);
}

export function setLatencyChartGeometry(spanMin: number, spanMax: number, viewportSec: number): void {
  latencySpanMin = spanMin;
  latencySpanMax = Math.max(spanMin, spanMax);
  latencyChartViewportSec = Math.max(1, viewportSec);
  // Default first view: latest slice ending at span max.
  latencyViewMax = latencySpanMax;
}

export function latencyChartSpanSec(): number {
  return Math.max(0, latencySpanMax - latencySpanMin);
}

/** True when the full data span is longer than one viewport (selected range). */
export function isLatencyChartScrollable(
  spanSec: number = latencyChartSpanSec(),
  viewportSec: number = latencyChartViewportSec,
): boolean {
  return spanSec > viewportSec + 1;
}

/**
 * Visible X window for the current pan position.
 * viewMax is the right edge; width is the selected range (clamped to history).
 */
export function visibleXWindow(
  viewMax: number = latencyViewMax,
  viewportSec: number = latencyChartViewportSec,
  spanMin: number = latencySpanMin,
  spanMax: number = latencySpanMax,
): { min: number; max: number } {
  const max = Math.min(spanMax, Math.max(spanMin, viewMax));
  let min = max - viewportSec;
  if (min < spanMin) min = spanMin;
  return { min, max };
}

/** Map scrollbar position t∈[0,1] (0=oldest, 1=latest) to viewMax. */
export function viewMaxFromScrollRatio(
  t: number,
  viewportSec: number,
  spanMin: number,
  spanMax: number,
): number {
  const span = spanMax - spanMin;
  const travel = Math.max(0, span - viewportSec);
  const clamped = Math.min(1, Math.max(0, t));
  return spanMin + viewportSec + clamped * travel;
}

export function scrollRatioFromViewMax(
  viewMax: number,
  viewportSec: number,
  spanMin: number,
  spanMax: number,
): number {
  const travel = Math.max(0, spanMax - spanMin - viewportSec);
  if (travel <= 0) return 1;
  return Math.min(1, Math.max(0, (viewMax - spanMin - viewportSec) / travel));
}

function getLatencyLayoutElements(): {
  container: HTMLElement | null;
  scroll: HTMLElement | null;
  inner: HTMLElement | null;
  legend: HTMLElement | null;
} {
  return {
    container: document.getElementById("latencyChartContainer"),
    scroll: document.getElementById("latencyChartScroll"),
    inner: document.getElementById("latencyChartInner"),
    legend: document.getElementById("latencyLegend"),
  };
}

function applyVisibleWindowToChart(): void {
  if (!latencyChart) return;
  const { min, max } = visibleXWindow();
  const x = latencyChart.options.scales?.x;
  if (x && typeof x === "object") {
    (x as { min?: number; max?: number }).min = min;
    (x as { max?: number }).max = max;
  }
  latencyChart.update("none");
}

function onLatencyHistoryScroll(): void {
  if (!latencyScrollMode) return;
  if (latencyScrollRaf) cancelAnimationFrame(latencyScrollRaf);
  latencyScrollRaf = requestAnimationFrame(() => {
    latencyScrollRaf = 0;
    const { scroll } = getLatencyLayoutElements();
    if (!scroll) return;
    const maxScroll = scroll.scrollWidth - scroll.clientWidth;
    const t = maxScroll <= 0 ? 1 : scroll.scrollLeft / maxScroll;
    latencyViewMax = viewMaxFromScrollRatio(
      t,
      latencyChartViewportSec,
      latencySpanMin,
      latencySpanMax,
    );
    applyVisibleWindowToChart();
  });
}

function ensureLatencyScrollListener(): void {
  if (latencyScrollListenerBound) return;
  const { scroll } = getLatencyLayoutElements();
  if (!scroll) return;
  scroll.addEventListener("scroll", onLatencyHistoryScroll, { passive: true });
  latencyScrollListenerBound = true;
}

/**
 * Size the history scrollbar spacer and optionally pin to the latest viewport.
 * Chart canvas always fills the plot frame; only the X domain pans.
 */
export function applyLatencyChartLayout(scrollToEnd = false): boolean {
  const { container, scroll, inner } = getLatencyLayoutElements();
  if (!container || !scroll || !inner) {
    latencyScrollMode = false;
    return false;
  }

  ensureLatencyScrollListener();

  const needsScroll = isLatencyChartScrollable();
  container.classList.toggle("is-scrollable", needsScroll);
  scroll.hidden = !needsScroll;

  if (!needsScroll) {
    inner.style.width = "100%";
    scroll.scrollLeft = 0;
    latencyScrollMode = false;
    latencyViewMax = latencySpanMax;
    return false;
  }

  const trackW = scroll.clientWidth || container.clientWidth;
  const spanSec = latencyChartSpanSec();
  const contentW = latencyChartScrollWidth(trackW, latencyChartViewportSec, spanSec);
  inner.style.width = `${contentW}px`;
  latencyScrollMode = true;

  if (scrollToEnd) {
    latencyViewMax = latencySpanMax;
    const maxScroll = Math.max(0, contentW - trackW);
    scroll.scrollLeft = maxScroll;
    // Layout may lag one frame for scrollWidth on some engines.
    requestAnimationFrame(() => {
      const s = getLatencyLayoutElements().scroll;
      if (!s || !latencyScrollMode) return;
      s.scrollLeft = Math.max(0, s.scrollWidth - s.clientWidth);
      latencyViewMax = latencySpanMax;
      applyVisibleWindowToChart();
    });
  }

  return true;
}

/** Pin the history scrubber (and X window) to the most recent data. */
export function scrollLatencyChartToLatest(): void {
  latencyViewMax = latencySpanMax;
  applyLatencyChartLayout(true);
  applyVisibleWindowToChart();
}

export function isLatencyScrollMode(): boolean {
  return latencyScrollMode;
}

/**
 * Call after window resize or container size changes.
 * Rebuilds scrubber width; keeps latest view when already at the end (or forced).
 */
export function resizeLatencyChartLayout(scrollToEnd = false): void {
  const { scroll } = getLatencyLayoutElements();
  const atEnd =
    !scroll ||
    scroll.hidden ||
    scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 4;
  const pin = scrollToEnd || atEnd;

  if (!pin && scroll && latencyScrollMode) {
    const maxScroll = Math.max(1, scroll.scrollWidth - scroll.clientWidth);
    const t = scroll.scrollLeft / maxScroll;
    latencyViewMax = viewMaxFromScrollRatio(
      t,
      latencyChartViewportSec,
      latencySpanMin,
      latencySpanMax,
    );
  }

  applyLatencyChartLayout(pin);
  if (pin) {
    latencyViewMax = latencySpanMax;
  }
  applyVisibleWindowToChart();
  latencyChart?.resize();
}

export function visibleWindowFromBounds(bounds: TimeBounds): { min: number; max: number } {
  return visibleXWindow(bounds.max, bounds.viewportSec, bounds.min, bounds.max);
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
  // Full history domain for pan; plot shows only the selected viewport window.
  setLatencyChartGeometry(xBounds.min, xBounds.max, xBounds.viewportSec);
  latencyViewMax = xBounds.max;
  const view = visibleXWindow(xBounds.max, xBounds.viewportSec, xBounds.min, xBounds.max);
  // Labels follow the zoom (selected range), not the full multi-day span.
  const viewTickStep = chartTickStep(xBounds.viewportSec, compact);
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

  // Scrubber + pin to latest (first view = most recent selected range).
  applyLatencyChartLayout(true);

  latencyChart?.destroy();

  const config = {
    type: "line",
    plugins: [createBatchTooltipPlugin(batchTimestamps)],
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: {
          type: "linear",
          // Only the selected duration is on screen; pan via history scrollbar.
          min: view.min,
          max: view.max,
          grid: { color: "#2a2e3d" },
          ticks: {
            color: "#8b90a0",
            stepSize: viewTickStep,
            autoSkip: true,
            maxRotation: 0,
            maxTicksLimit: compact ? 6 : 12,
            font: compact ? { size: 10 } : undefined,
            callback: (value: string | number) =>
              fmtAxisTick(Number(value), viewTickStep, compact),
          },
        },
        y: {
          title: {
            display: true,
            text: "ms",
            color: "#8b90a0",
          },
          grid: { color: "#2a2e3d" },
          ticks: {
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

  // Ensure scrubber is at the right edge after Chart layout.
  requestAnimationFrame(() => {
    scrollLatencyChartToLatest();
    latencyChart?.resize();
  });
}