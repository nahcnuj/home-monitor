import { Chart, registerables } from "chart.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateByServer, filterByPeriod, parseTsv } from "../data.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./plugins.ts";
import { buildLatencyChart, getLatencyChart, latencyTooltipTitle } from "./latency.ts";
import { buildErrorChart } from "./error.ts";
import { sampleTsv } from "../test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "../state.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

describe("latencyTooltipTitle", () => {
  it("returns empty string when tooltip items are filtered out", () => {
    expect(latencyTooltipTitle([])).toBe("");
  });
});

describe("buildLatencyChart", () => {
  beforeAll(() => {
    document.body.innerHTML = `
      <canvas id="latencyChart" width="800" height="400"></canvas>
      <canvas id="errorChart" width="800" height="200"></canvas>
    `;
    setDisplayRangeSec(3600);
    setDataCutoffTs(1781960400);
  });

  it("renders charts from published TSV without throwing", () => {
    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781960400);
    const { successes, failures } = aggregateByServer(filtered);
    const stats = failures.reduce<Record<string, number>>((acc, row) => {
      acc[row.error] = (acc[row.error] || 0) + 1;
      return acc;
    }, {});

    expect(() => {
      buildLatencyChart(filtered, successes, failures, 1781960400);
      buildErrorChart(stats);
    }).not.toThrow();

    expect(getLatencyChart()).not.toBeNull();
  });

  it("renders when no records fall in the display window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1900000000 * 1000));

    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 0);
    expect(filtered).toHaveLength(0);

    expect(() => {
      buildLatencyChart(filtered, [], [], 0);
      buildErrorChart({});
    }).not.toThrow();

    vi.useRealTimers();
  });
});