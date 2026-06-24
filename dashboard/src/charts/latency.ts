import {
  Chart,
  type ChartConfiguration,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import { ERROR_COLORS, HIDE_LATENCY_POINTS_RANGE_SEC, MAX_GAP_SEC, SERVER_COLORS } from "../constants.ts";
import { formatErrorCode, isDnsErrorCode } from "../errors.ts";
import { displayRangeSec } from "../state.ts";
import { buildRollingEnvelope, collectTimelineTimestamps } from "./rolling-envelope.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
  LatencySamplePoint,
} from "../types.ts";
import { timeoutRanges, withAlpha, withGaps } from "../utils.ts";

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
  }));
}

export function formatFailureLabel(point: FailurePoint): string {
  const domain = point.domain ? ` / ${point.domain}` : "";
  return `${point.dns_server}${domain}: ${formatErrorCode(point.error)}`;
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
const IQR_BAND_ALPHA = 0.18;
const IQR_BAND_ALPHA_LONG = 0.32;
const MINMAX_BAND_ALPHA = 0.07;
const MINMAX_BAND_ALPHA_LONG = 0.12;
const TIMEOUT_EDGE_WIDTH = 2;

export function shouldShowLatencyPoints(rangeSec: number = displayRangeSec): boolean {
  return rangeSec < HIDE_LATENCY_POINTS_RANGE_SEC;
}

let latencyChart: Chart | null = null;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

function isHiddenBand(label: string | undefined): boolean {
  return !!label?.endsWith(" min")
    || !!label?.endsWith(" max")
    || !!label?.endsWith(" q1")
    || !!label?.endsWith(" q3");
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
  const latestDataTs = rawRecords.length ? Math.max(...rawRecords.map((r) => r.ts)) : null;
  const xBounds = chartTimeBounds(undefined, latestDataTs);
  const { timestamps, step } = collectTimelineTimestamps(rawRecords, xBounds.min, xBounds.max);
  const maxGapSec = Math.max(MAX_GAP_SEC, MAX_GAP_SEC * step);
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];
  const showPoints = shouldShowLatencyPoints();
  const iqrBandAlpha = showPoints ? IQR_BAND_ALPHA : IQR_BAND_ALPHA_LONG;
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
      label: `${server} q3`,
      order: 3,
      data: withGaps(envelope.q3, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: "transparent",
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: false,
      spanGaps: false,
    });
    datasets.push({
      label: `${server} q1`,
      order: 3,
      data: withGaps(envelope.q1, envelope.emptyTimestamps, maxGapSec),
      borderColor: "transparent",
      backgroundColor: withAlpha(color, iqrBandAlpha),
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

  const failurePoints = buildFailurePoints(rawRecords);
  const failureCodes = [...new Set(failurePoints.map((point) => point.error))].sort((a, b) =>
    formatErrorCode(a).localeCompare(formatErrorCode(b), "ja"),
  );

  for (const code of failureCodes) {
    const color = ERROR_COLORS[code] ?? "#8b90a0";
    datasets.push({
      label: code,
      type: "scatter",
      order: 0,
      data: failurePoints.filter((point) => point.error === code),
      borderColor: color,
      backgroundColor: color,
      pointRadius: showPoints ? 3.5 : 0,
      pointHoverRadius: showPoints ? 4 : 0,
      pointStyle: "crossRot",
      showLine: false,
    });
  }

  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  if (!canvas) return;

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
          min: xBounds.min,
          max: xBounds.max,
          grid: { color: "#2a2e3d" },
          ticks: {
            color: "#8b90a0",
            stepSize: xBounds.tickStep,
            autoSkip: false,
            maxRotation: 0,
            callback: (value: string | number) => fmtAxisTick(Number(value), xBounds.tickStep),
          },
        },
        y: {
          title: { display: true, text: "ms", color: "#8b90a0" },
          grid: { color: "#2a2e3d" },
          ticks: { color: "#8b90a0" },
          min: 0,
        },
      },
      plugins: {
        chartRegions: {
          xMin: xBounds.min,
          cutoffEnd: dataCutoffTs > xBounds.min ? dataCutoffTs : 0,
          timeoutRanges: timeoutRanges(allFailures),
          timeoutEdgeWidth: showPoints ? TIMEOUT_EDGE_WIDTH : 0,
        },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item: { text: string }) => !isHiddenBand(item.text) && !isDnsErrorCode(item.text),
          },
        },
        tooltip: {
          filter: (item: TooltipItem<"line">) => isTooltipDataset(item.dataset.label),
          itemSort: (a: TooltipItem<"line">, b: TooltipItem<"line">) => {
            const aFail = isDnsErrorCode(a.dataset.label);
            const bFail = isDnsErrorCode(b.dataset.label);
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
}