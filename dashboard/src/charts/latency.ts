import {
  Chart,
  type ChartConfiguration,
  type TooltipItem,
} from "chart.js";
import { SERVER_COLORS } from "../constants.ts";
import { latencyValuesAt } from "./latency-data.ts";
import { buildViolinSeries } from "./violin-overlay.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
} from "../types.ts";
import { timeoutRanges, timeoutSpansForServer, withGaps } from "../utils.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

let latencyChart: Chart | null = null;

export function getLatencyChart(): Chart | null {
  return latencyChart;
}

export function buildLatencyChart(
  rawRecords: DnsRecord[],
  successes: AggregatedSuccess[],
  failures: DnsFailureRecord[],
  dataCutoffTs: number,
): void {
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];
  const skipSpansByServer = new Map<string, { start: number; end: number }[]>();

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const spans = timeoutSpansForServer(failures, server);
    skipSpansByServer.set(server, spans);

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
      tension: 0.1,
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

  const xBounds = chartTimeBounds();
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
        violinTimeSeries: {
          series: buildViolinSeries(rawRecords, servers, SERVER_COLORS, skipSpansByServer),
        },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item: { text: string }) => item.text !== "Failures",
          },
        },
        tooltip: {
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