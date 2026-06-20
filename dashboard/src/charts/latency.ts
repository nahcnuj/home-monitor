import {
  Chart,
  type ChartConfiguration,
  type TooltipItem,
} from "chart.js";
import { SERVER_COLORS } from "../constants.ts";
import { chartTimeBounds, fmtAxisTick, fmtJst } from "../time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  FailurePoint,
  LatencySamplePoint,
} from "../types.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}
import { latencyRanges, timeoutRanges, withAlpha, withGaps } from "../utils.ts";

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

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const serverTimeouts = failures
      .filter((r) => r.dns_server === server && r.error === "timeout")
      .map((r) => r.ts);

    datasets.push({
      label: server,
      order: 2,
      data: withGaps(
        successes
          .filter((r) => r.dns_server === server)
          .map((r) => ({ x: r.ts, y: r.latency_ms })),
        serverTimeouts,
      ),
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.1,
      fill: false,
      spanGaps: false,
    });

    const samples = rawRecords.filter((r): r is DnsSuccessRecord => isSuccess(r) && r.dns_server === server);
    if (samples.length) {
      datasets.push({
        label: `${server} samples`,
        type: "scatter",
        order: 1,
        data: samples.map((r): LatencySamplePoint => ({
          x: r.ts,
          y: r.latency_ms,
          domain: r.domain,
        })),
        borderColor: color,
        backgroundColor: withAlpha(color, 0.55),
        pointRadius: 1.5,
        pointHoverRadius: 2.5,
        showLine: false,
      });
    }
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
        latencyRange: { ranges: latencyRanges(rawRecords, servers) },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item: { text: string }) => !item.text.endsWith(" samples"),
          },
        },
        tooltip: {
          callbacks: {
            title: (items: TooltipItem<"line">[]) => fmtJst(items[0].parsed.x as number),
            label(ctx: TooltipItem<"line">) {
              const raw = ctx.raw as FailurePoint | LatencySamplePoint;
              if ("error" in raw && raw.error) {
                const domain = raw.domain ? ` / ${raw.domain}` : "";
                return `${raw.dns_server}${domain}: ${raw.error}`;
              }
              if ("domain" in raw && raw.domain) {
                return `${raw.domain}: ${Math.round(raw.y)} ms`;
              }
              if (ctx.dataset.label?.endsWith(" samples")) {
                return `${Math.round(raw.y)} ms`;
              }
              return `${ctx.dataset.label} 平均: ${Math.round(raw.y)} ms`;
            },
          },
        },
      },
    },
  };
  latencyChart = new Chart(canvas, config as ChartConfiguration);
}