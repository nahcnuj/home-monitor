import {
  Chart,
  type ChartConfiguration,
  type TooltipItem,
} from "chart.js";
import { SERVER_COLORS } from "../constants.ts";
import { latencyValuesAt } from "./latency-data.ts";
import { buildRollingEnvelope, collectTimelineTimestamps } from "./rolling-envelope.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
} from "../types.ts";
import { timeoutRanges, timeoutSpansForServer, withAlpha, withGaps } from "../utils.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

const BAND_TENSION = 0.42;

let latencyChart: Chart | null = null;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

function isHiddenBand(label: string | undefined): boolean {
  return !!label?.endsWith(" max")
    || !!label?.endsWith(" min")
    || !!label?.endsWith(" q1")
    || !!label?.endsWith(" q3");
}

export function buildLatencyChart(
  rawRecords: DnsRecord[],
  successes: AggregatedSuccess[],
  failures: DnsFailureRecord[],
  dataCutoffTs: number,
): void {
  const xBounds = chartTimeBounds();
  const timestamps = collectTimelineTimestamps(rawRecords, xBounds.min, xBounds.max);
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const spans = timeoutSpansForServer(failures, server);
    const envelope = buildRollingEnvelope(rawRecords, server, timestamps, spans);

    datasets.push({
      label: `${server} max`,
      order: 3,
      data: withGaps(envelope.max, spans),
      borderColor: withAlpha(color, 0.35),
      backgroundColor: "transparent",
      borderWidth: 1,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: false,
      spanGaps: false,
    });
    datasets.push({
      label: `${server} min`,
      order: 3,
      data: withGaps(envelope.min, spans),
      borderColor: withAlpha(color, 0.35),
      backgroundColor: withAlpha(color, 0.1),
      borderWidth: 1,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: "-1",
      spanGaps: false,
    });
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
      backgroundColor: withAlpha(color, 0.22),
      borderWidth: 0,
      pointRadius: 0,
      tension: BAND_TENSION,
      fill: "-1",
      spanGaps: false,
    });

    datasets.push({
      label: server,
      order: 2,
      data: withGaps(
        successes
          .filter((r) => r.dns_server === server)
          .map((r) => ({ x: r.ts, y: r.latency_ms })),
        spans,
      ),
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.15,
      fill: false,
      spanGaps: false,
    });
  });

  const failurePoints: FailurePoint[] = failures.map((r) => ({
    x: r.ts,
    y: 0,
    error: r.error,
    dns_server: r.dns_server,
    domain: r.domain,
  }));

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
      interaction: { mode: "nearest", intersect: false },
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
          timeoutRanges: timeoutRanges(failures),
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
            title: (items: TooltipItem<"line">[]) => fmtJst(items[0].parsed.x as number),
            label(ctx: TooltipItem<"line">) {
              const raw = ctx.raw as FailurePoint | { x: number; y: number };
              if ("error" in raw && raw.error) {
                const domain = raw.domain ? ` / ${raw.domain}` : "";
                return `${raw.dns_server}${domain}: ${raw.error}`;
              }

              const server = ctx.dataset.label ?? "";
              const ts = raw.x;
              const values = latencyValuesAt(rawRecords, server, ts);
              const avg = Math.round(raw.y);
              if (values.length >= 2) {
                const min = Math.min(...values);
                const max = Math.max(...values);
                return `${server} 平均: ${avg} ms (${min}–${max})`;
              }
              return `${server} 平均: ${avg} ms`;
            },
          },
        },
      },
    },
  };
  latencyChart = new Chart(canvas, config as ChartConfiguration);
}