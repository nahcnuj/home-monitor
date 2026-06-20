import {
  Chart,
  type ChartConfiguration,
  type TooltipItem,
} from "chart.js";
import { SERVER_COLORS } from "../constants.ts";
import {
  averageAt,
  collectTimestamps,
  failurePointsAt,
  latencyValuesAt,
  violinDataAt,
} from "./latency-data.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
} from "../types.ts";
import { timeoutRanges, withAlpha } from "../utils.ts";

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
  const xBounds = chartTimeBounds();
  const timestamps = collectTimestamps(rawRecords, xBounds);
  const servers = [...new Set(rawRecords.filter(isSuccess).map((r) => r.dns_server))].sort();
  const datasets: ChartConfiguration["data"]["datasets"] = [];

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const skipTs = new Set(
      failures
        .filter((r) => r.dns_server === server && r.error === "timeout")
        .map((r) => r.ts),
    );

    datasets.push({
      type: "violin",
      label: server,
      order: 2,
      data: timestamps.map((ts) => violinDataAt(rawRecords, server, ts, skipTs)),
      backgroundColor: withAlpha(color, 0.32),
      borderColor: withAlpha(color, 0.75),
      borderWidth: 1,
      maxBarThickness: 22,
      outlierRadius: 0,
      itemRadius: 0,
      meanRadius: 0,
    });

    datasets.push({
      type: "line",
      label: `${server} avg`,
      order: 1,
      data: timestamps.map((ts) => averageAt(successes, server, ts, skipTs)),
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.1,
      fill: false,
      spanGaps: false,
    });
  });

  datasets.push({
    type: "scatter",
    label: "Failures",
    order: 0,
    data: failurePointsAt(failures, timestamps),
    borderColor: "#f87171",
    backgroundColor: "#f87171",
    pointRadius: 5,
    pointStyle: "crossRot",
    showLine: false,
  });

  const canvas = document.getElementById("latencyChart") as HTMLCanvasElement | null;
  if (!canvas) return;

  latencyChart?.destroy();
  const config: ChartConfiguration = {
    type: "line",
    data: {
      labels: timestamps.map(String),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "category",
          grid: { color: "#2a2e3d" },
          ticks: {
            color: "#8b90a0",
            autoSkip: true,
            maxTicksLimit: 12,
            maxRotation: 0,
            callback: (_value, index) => {
              const ts = timestamps[index];
              return ts ? fmtAxisTick(ts, xBounds.tickStep) : "";
            },
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
          timestamps,
          xMin: xBounds.min,
          cutoffEnd: dataCutoffTs > xBounds.min ? dataCutoffTs : 0,
          timeoutRanges: timeoutRanges(failures),
        },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item, chartData) => {
              const index = item.datasetIndex;
              if (index === undefined) return false;
              return chartData.datasets[index]?.type === "violin";
            },
          },
        },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<"line">[]) => {
              const ts = timestamps[items[0]?.dataIndex ?? 0];
              return ts ? fmtJst(ts) : "";
            },
            label(ctx: TooltipItem<"line">) {
              const raw = ctx.raw as
                | { x: number; y: number; error?: string; dns_server?: string; domain?: string | null }
                | number
                | null;
              if (raw && typeof raw === "object" && "error" in raw && raw.error) {
                const domain = raw.domain ? ` / ${raw.domain}` : "";
                return `${raw.dns_server}${domain}: ${raw.error}`;
              }
              if (ctx.dataset.type === "line") {
                const server = (ctx.dataset.label ?? "").replace(/ avg$/, "");
                const ts = timestamps[ctx.dataIndex];
                const values = ts ? latencyValuesAt(rawRecords, server, ts) : [];
                const avg = typeof raw === "number" ? Math.round(raw) : "-";
                if (values.length >= 2) {
                  const min = Math.min(...values);
                  const max = Math.max(...values);
                  return `${server} 平均: ${avg} ms (${min}–${max})`;
                }
                return `${server} 平均: ${avg} ms`;
              }
              if (ctx.dataset.type === "violin" && typeof ctx.formattedValue === "string") {
                return ctx.formattedValue;
              }
              return ctx.formattedValue;
            },
          },
        },
      },
    },
  };
  latencyChart = new Chart(canvas, config);
}