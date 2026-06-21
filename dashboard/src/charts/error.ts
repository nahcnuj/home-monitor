import { Chart, Tooltip, type TooltipItem } from "chart.js";
import { ERROR_COLORS, SERVER_COLORS } from "../constants.ts";
import { formatErrorCode, formatErrorDescription } from "../errors.ts";

interface ErrorBarDataset {
  label: string;
  errorCode: string;
  data: number[];
  backgroundColor: string;
  borderWidth: number;
  borderRadius: BorderRadius;
}

type TooltipBarElement = { x: number; base: number };

let errorChart: Chart<"bar"> | null = null;
let errorBarPositionerRegistered = false;

type BorderRadius = number | { topLeft: number; bottomLeft: number; topRight: number; bottomRight: number };

export function errorTooltipAnchor(
  bar: TooltipBarElement,
  chartAreaBottom: number,
): { x: number; y: number } {
  const left = Math.min(bar.x, bar.base);
  const right = Math.max(bar.x, bar.base);
  return {
    x: (left + right) / 2,
    y: chartAreaBottom + 8,
  };
}

function registerErrorBarTooltipPositioner(): void {
  if (errorBarPositionerRegistered) return;

  Tooltip.positioners.errorBarBelow = (
    items: TooltipItem<"bar">[],
    _eventPosition: { x: number; y: number },
  ) => {
    if (!items.length) return false;
    const chart = items[0].chart;
    const bar = items[0].element as unknown as TooltipBarElement;
    return errorTooltipAnchor(bar, chart.chartArea.bottom);
  };

  errorBarPositionerRegistered = true;
}

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
  registerErrorBarTooltipPositioner();

  const codes = Object.keys(errors).sort((a, b) => errors[b] - errors[a]);
  const total = codes.reduce((sum, code) => sum + errors[code], 0);
  const canvas = document.getElementById("errorChart") as HTMLCanvasElement | null;
  if (!canvas) return;

  errorChart?.destroy();

  const datasets: ErrorBarDataset[] = codes.length
    ? codes.map((code, index) => ({
        label: formatErrorCode(code),
        errorCode: code,
        data: [errors[code]],
        backgroundColor: ERROR_COLORS[code] || SERVER_COLORS[index % SERVER_COLORS.length],
        borderWidth: 0,
        borderRadius: errorBandRadius(index, codes.length),
      }))
    : [{
        label: "なし",
        errorCode: "",
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
          position: "errorBarBelow",
          xAlign: "center",
          yAlign: "top",
          caretPadding: 4,
          callbacks: {
            label(ctx) {
              const dataset = ctx.dataset as ErrorBarDataset;
              const count = ctx.raw as number;
              const pct = total ? ((count / total) * 100).toFixed(1) : "0.0";
              const lines = [`${dataset.label}: ${count} (${pct}%)`];
              const description = formatErrorDescription(dataset.errorCode);
              if (description) lines.push(description);
              return lines;
            },
          },
        },
      },
    },
  });
}