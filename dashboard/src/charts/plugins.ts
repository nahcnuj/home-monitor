import type { Plugin } from "chart.js";
import { readableTextColor } from "../utils.ts";

interface ChartRegionsOptions {
  cutoffEnd?: number;
  xMin?: number;
  timeoutRanges?: { start: number; end: number }[];
  timeoutEdgeWidth?: number;
  minTimeoutBarWidth?: number;
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

    const timeoutEdgeWidth = options?.timeoutEdgeWidth ?? 2;
    // Error bars (timeouts and other failures): never thinner than 1 CSS pixel.
    const minBarWidth = Math.max(1, options?.minTimeoutBarWidth ?? 1);

    for (const { start, end } of options?.timeoutRanges ?? []) {
      const x0 = xScale.getPixelForValue(start);
      const x1 = xScale.getPixelForValue(Math.max(end, start));
      let left = Math.min(x0, x1);
      let width = Math.max(Math.abs(x1 - x0), minBarWidth);

      // Clip to plot area; if the event is in view, keep at least minBarWidth.
      if (left + width < chartArea.left || left > chartArea.right) continue;
      if (left < chartArea.left) {
        width -= chartArea.left - left;
        left = chartArea.left;
      }
      if (left + width > chartArea.right) {
        width = chartArea.right - left;
      }
      if (width < minBarWidth) {
        if (x0 < chartArea.left || x0 > chartArea.right) continue;
        left = Math.min(Math.max(x0, chartArea.left), chartArea.right - minBarWidth);
        width = minBarWidth;
      }
      if (width <= 0) continue;

      ctx.fillStyle = "rgba(248, 113, 113, 0.28)";
      ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);

      if (timeoutEdgeWidth > 0) {
        ctx.fillStyle = "rgba(248, 113, 113, 0.55)";
        ctx.fillRect(left, chartArea.top, width, chartArea.bottom - chartArea.top);
      }
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
      // Prefer full label when possible; fall back so small segments still show a cue.
      const full = `${label} ${count} (${pct}%)`;
      const medium = `${label} ${count}`;
      const short = width >= 28 ? `${pct}%` : "";
      let text = "";
      if (width >= 100) text = full;
      else if (width >= 72) text = medium;
      else if (width >= 48) text = label;
      else text = short;

      if (!text) return;

      const color = dataset.backgroundColor;
      const fill = typeof color === "string" ? readableTextColor(color) : "#fff";
      const cx = left + width / 2;
      const cy = bar.y;

      ctx.font = "600 11px Segoe UI, system-ui, sans-serif";
      // Avoid drawing labels that still overflow after truncation tiers.
      if (ctx.measureText(text).width > width - 6) {
        if (width >= 28) text = `${pct}%`;
        else return;
        if (ctx.measureText(text).width > width - 4) return;
      }

      ctx.fillStyle = fill === "#fff" ? "rgba(0, 0, 0, 0.4)" : "rgba(255, 255, 255, 0.35)";
      ctx.fillText(text, cx + 1, cy + 1);
      ctx.fillStyle = fill;
      ctx.fillText(text, cx, cy);
    });

    ctx.restore();
  },
};