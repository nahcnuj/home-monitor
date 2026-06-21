import { Chart } from "chart.js";
import { ERROR_COLORS, SERVER_COLORS } from "../constants.ts";
import { formatErrorCode } from "../errors.ts";

let errorChart: Chart<"bar"> | null = null;

type BorderRadius = number | { topLeft: number; bottomLeft: number; topRight: number; bottomRight: number };

function errorBandRadius(index: number, count: number): BorderRadius {
  if (count <= 1) return 6;
  if (index === 0) return { topLeft: 6, bottomLeft: 6, topRight: 0, bottomRight: 0 };
  if (index === count - 1) return { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 };
  return 0;
}

export function getErrorChart(): Chart<"bar"> | null {
  return errorChart;
}

export function buildErrorChart(errors: Record<string, number>): void {
  const codes = Object.keys(errors).sort((a, b) => errors[b] - errors[a]);
  const total = codes.reduce((sum, code) => sum + errors[code], 0);
  const canvas = document.getElementById("errorChart") as HTMLCanvasElement | null;
  if (!canvas) return;

  errorChart?.destroy();

  const datasets = codes.length
    ? codes.map((code, index) => ({
        label: formatErrorCode(code),
        data: [errors[code]],
        backgroundColor: ERROR_COLORS[code] || SERVER_COLORS[index % SERVER_COLORS.length],
        borderWidth: 0,
        borderRadius: errorBandRadius(index, codes.length),
      }))
    : [{
        label: "なし",
        data: [1],
        backgroundColor: "#2a2e3d",
        borderWidth: 0,
        borderRadius: 6,
      }];

  errorChart = new Chart(canvas, {
    type: "bar",
    data: { labels: [""], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      datasets: { bar: { barThickness: 36 } },
      scales: {
        x: {
          stacked: true,
          display: false,
          max: codes.length ? total : 1,
        },
        y: {
          stacked: true,
          display: false,
        },
      },
      plugins: {
        errorBandLabels: {
          total,
          empty: !codes.length,
        },
        legend: { display: false },
        tooltip: {
          filter: () => codes.length > 0,
          callbacks: {
            label(ctx) {
              const count = ctx.raw as number;
              const pct = total ? ((count / total) * 100).toFixed(1) : "0.0";
              return `${ctx.dataset.label}: ${count} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}