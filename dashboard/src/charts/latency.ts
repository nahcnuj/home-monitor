import {
  Chart,
  type ChartConfiguration,
  type TooltipItem,
} from "chart.js";
import { SERVER_COLORS } from "../constants.ts";
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
import { timeoutRanges, timeoutSpansForServer, withAlpha, withGaps } from "../utils.ts";

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
  return `${point.dns_server}${domain}: ${point.error}`;
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

  for (const record of batch.filter(isSuccess).sort((a, b) => compareDomain(a.domain, b.domain))) {
    const name = record.domain ?? record.dns_server;
    lines.push(`${name}: ${Math.round(record.latency_ms)} ms`);
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

export function resolveTooltipBatchTs(
  chart: Chart,
  batchTimestamps: readonly number[],
): number | null {
  const scale = chart.scales.x;
  const caretX = chart.tooltip?.caretX;
  if (!scale || caretX == null) return null;

  const hoverValue = scale.getValueForPixel(caretX);
  if (hoverValue == null || Number.isNaN(Number(hoverValue))) return null;

  return nearestBatchTs(batchTimestamps, Number(hoverValue));
}

const BAND_TENSION = 0.42;

let latencyChart: Chart | null = null;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

function isHiddenBand(label: string | undefined): boolean {
  return !!label?.endsWith(" q1") || !!label?.endsWith(" q3");
}

export function latencyTooltipTitle(
  items: TooltipItem<"line">[],
  batchTimestamps: readonly number[],
): string {
  const chart = items[0]?.chart;
  if (!chart) return "";

  const ts = resolveTooltipBatchTs(chart, batchTimestamps);
  return ts == null ? "" : fmtJst(ts);
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
  const timestamps = collectTimelineTimestamps(rawRecords, xBounds.min, xBounds.max);
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const spans = timeoutSpansForServer(allFailures, server);
    const envelope = buildRollingEnvelope(rawRecords, server, timestamps, spans);

    datasets.push({
      label: `${server} q3`,
      order: 3,
      data: withGaps(envelope.q3, spans),
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
      data: withGaps(envelope.q1, spans),
      borderColor: "transparent",
      backgroundColor: withAlpha(color, 0.18),
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
        pointRadius: 2.5,
        pointHoverRadius: 4,
        showLine: false,
      });
    }
  });

  const failurePoints = buildFailurePoints(rawRecords);

  datasets.push({
    label: "Failures",
    order: 0,
    data: failurePoints,
    borderColor: "#f87171",
    backgroundColor: "#f87171",
    pointRadius: 5,
    pointStyle: "crossRot",
    showLine: false,
  });

  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  if (!canvas) return;

  latencyChart?.destroy();
  const config = {
    type: "line",
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
        },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item: { text: string }) => !isHiddenBand(item.text) && item.text !== "Failures",
          },
        },
        tooltip: {
          filter: (item: TooltipItem<"line">) => !isHiddenBand(item.dataset.label),
          callbacks: {
            title: (items: TooltipItem<"line">[]) => latencyTooltipTitle(items, batchTimestamps),
            label: () => "",
            afterBody: (items: TooltipItem<"line">[]) => {
              const chart = items[0]?.chart;
              if (!chart) return [];
              const ts = resolveTooltipBatchTs(chart, batchTimestamps);
              return ts == null ? [] : buildTooltipLines(rawRecords, ts);
            },
          },
        },
      },
    },
  };
  latencyChart = new Chart(canvas, config as ChartConfiguration);
}