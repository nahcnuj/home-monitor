import { Chart, registerables } from "chart.js";
import { beforeAll, describe, expect, it } from "vitest";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./plugins.ts";
import { buildErrorChart, errorTooltipAnchor, getErrorChart } from "./error.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

beforeAll(() => {
  document.body.innerHTML = `<canvas id="errorChart" width="800" height="200"></canvas>`;
  const canvas = document.getElementById("errorChart") as HTMLCanvasElement;
  canvas.width = 800;
  canvas.height = 200;
});

describe("errorTooltipAnchor", () => {
  it("anchors the tooltip below the hovered bar segment", () => {
    expect(errorTooltipAnchor({ x: 180, base: 60, y: 50, height: 36 })).toEqual({
      x: 120,
      y: 76,
    });
  });
});

describe("buildErrorChart tooltip", () => {
  it("shows the tooltip inside the canvas when a bar segment is active", () => {
    buildErrorChart({ job_timeout: 12, dns_timeout: 5 });

    const chart = getErrorChart();
    expect(chart).not.toBeNull();

    chart!.options.animation = false;
    chart!.update();

    const bar = chart!.getDatasetMeta(0).data[0] as unknown as {
      x: number;
      base: number;
      y: number;
      height: number;
    };
    const anchor = errorTooltipAnchor(bar);

    chart!.tooltip?.setActiveElements([{ datasetIndex: 0, index: 0 }], anchor);

    expect(chart!.tooltip?.getActiveElements()).toHaveLength(1);
    expect(chart!.tooltip?.body?.length).toBeGreaterThan(0);
    expect(chart!.tooltip?.opacity).toBe(1);
    expect(chart!.tooltip?.caretX).toBeCloseTo(anchor.x, 0);
    expect(chart!.tooltip?.caretY).toBeCloseTo(anchor.y, 0);
    expect(chart!.tooltip?.caretY).toBeGreaterThan(bar.y + bar.height / 2);
  });
});