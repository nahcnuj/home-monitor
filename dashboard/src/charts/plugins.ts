import type { Plugin } from "chart.js";
import { readableTextColor } from "../utils.ts";

interface ChartRegionsOptions {
  cutoffEnd?: number;
  xMin?: number;
  timeoutRanges?: { start: number; end: number }[];
}

interface ErrorBandLabelsOptions {
  empty?: boolean;
  total?: number;
}

export const chartRegionsPlugin: Plugin<"line"> = {
  id: "chartRegions",
  beforeDatasetsDraw(chart, _args, opts) {
    const options = opts as ChartRegionsOptions | undefined;
    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!chartArea || !xScale) return;

    ctx.save();

    const cutoffEnd = options?.cutoffEnd ?? 0;
    const xMin = options?.xMin ?? (xScale.min as number);
    if (cutoffEnd > xMin) {
      let left = xScale.getPixelForValue(xMin);
      let right = xScale.getPixelForValue(cutoffEnd);
      left = Math.max(left, chartArea.left);
      right = Math.min(right, chartArea.right);
      if (right > left) {
        ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
        ctx.fillStyle = "rgba(139, 144, 160, 0.45)";
        ctx.fillRect(right - 1, chartArea.top, 1, chartArea.bottom - chartArea.top);
      }
    }

    for (const { start, end } of options?.timeoutRanges ?? []) {
      let left = xScale.getPixelForValue(start);
      let right = xScale.getPixelForValue(end);
      left = Math.max(left, chartArea.left);
      right = Math.min(right, chartArea.right);
      if (right <= left) continue;

      ctx.fillStyle = "rgba(248, 113, 113, 0.28)";
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);

      ctx.fillStyle = "rgba(248, 113, 113, 0.55)";
      ctx.fillRect(left, chartArea.top, 2, chartArea.bottom - chartArea.top);
    }

    ctx.restore();
  },
};

export const errorBandLabelsPlugin: Plugin<"bar"> = {
  id: "errorBandLabels",
  afterDatasetsDraw(chart, _args, opts) {
    const options = opts as ErrorBandLabelsOptions | undefined;
    const { ctx } = chart;

    if (options?.empty) {
      const bar = chart.getDatasetMeta(0)?.data[0] as { x: number; y: number } | undefined;
      if (!bar) return;
      ctx.save();
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
      ctx.fillStyle = "#8b90a0";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("なし", bar.x, bar.y);
      ctx.restore();
      return;
    }

    const total = options?.total ?? 0;
    if (!total) return;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    chart.data.datasets.forEach((dataset, index) => {
      const bar = chart.getDatasetMeta(index)?.data[0] as unknown as
        | { x: number; y: number; base: number }
        | undefined;
      if (!bar) return;

      const left = Math.min(bar.x, bar.base);
      const right = Math.max(bar.x, bar.base);
      const width = right - left;
      const count = dataset.data[0] as number;
      const pct = Math.round((count / total) * 100);
      const label = dataset.label ?? "";
      const text =
        width >= 96 ? `${label} ${count} (${pct}%)`
        : width >= 64 ? `${label} ${count}`
        : width >= 40 ? label
        : "";

      if (!text) return;

      const color = dataset.backgroundColor;
      const fill = typeof color === "string" ? readableTextColor(color) : "#fff";
      const cx = left + width / 2;
      const cy = bar.y;

      ctx.font = "600 11px Segoe UI, system-ui, sans-serif";
      ctx.fillStyle = fill === "#fff" ? "rgba(0, 0, 0, 0.4)" : "rgba(255, 255, 255, 0.35)";
      ctx.fillText(text, cx + 1, cy + 1);
      ctx.fillStyle = fill;
      ctx.fillText(text, cx, cy);
    });

    ctx.restore();
  },
};