/**
 * Latency chart render benchmarks.
 *
 * Run: npm run bench
 * Compare before/after optimisations; numbers are machine-dependent.
 */
import { Chart, registerables } from "chart.js";
import { afterAll, beforeAll, bench, describe, vi } from "vitest";
import { aggregateByServer, computeStats } from "../data.ts";
import { setDisplayRangeSec } from "../state.ts";
import { generateBenchRecords } from "../test/bench-fixtures.ts";
import { DAY_SEC } from "../constants.ts";
import { buildLatencyChart, getLatencyChart } from "./latency.ts";

function destroyChart(): void {
  const chart = getLatencyChart();
  chart?.destroy();
}
import { buildRollingEnvelope, collectTimelineTimestamps } from "./rolling-envelope.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./plugins.ts";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

const START = 1_780_000_000;
/**
 * Production-like load: 7 days × 1 min × 2 servers × 8 domains ≈ 161k rows.
 * Built once at module load so setup cost is not inside each iteration.
 */
console.time("[bench] generate records");
const RECORDS = generateBenchRecords({
  days: 7,
  intervalSec: 60,
  startTs: START,
});
console.timeEnd("[bench] generate records");
console.log(`[bench] records=${RECORDS.length}`);
const NOW = START + 7 * DAY_SEC - 120;
const CUTOFF = START;

function ensureDom(): void {
  if (document.getElementById("latencyChart")) return;
  document.body.innerHTML = `
    <div id="latencyChartContainer" style="width:1000px;height:400px">
      <div class="chart-plot-frame" style="width:1000px;height:380px">
        <canvas id="latencyChart" width="1000" height="380"></canvas>
      </div>
      <div id="latencyChartScroll" style="width:1000px" hidden>
        <div id="latencyChartInner"></div>
      </div>
    </div>
  `;
  const scroll = document.getElementById("latencyChartScroll")!;
  Object.defineProperty(scroll, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(scroll, "scrollWidth", {
    configurable: true,
    get: () => {
      const inner = document.getElementById("latencyChartInner");
      const w = Number.parseInt(inner?.style.width ?? "1000", 10);
      return Number.isFinite(w) ? w : 1000;
    },
  });
  Object.defineProperty(scroll, "scrollLeft", { configurable: true, writable: true, value: 0 });
}

ensureDom();

describe("latency chart render bench (7d × 2 resolvers × 8 domains)", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW * 1000));
  });

  afterAll(() => {
    vi.useRealTimers();
    destroyChart();
  });

  bench(
    "collectTimelineTimestamps @ 24h viewport",
    () => {
      setDisplayRangeSec(DAY_SEC);
      collectTimelineTimestamps(RECORDS, CUTOFF, NOW, DAY_SEC);
    },
    { time: 500 },
  );

  bench(
    "buildRollingEnvelope × 2 servers @ 24h",
    () => {
      setDisplayRangeSec(DAY_SEC);
      const { timestamps } = collectTimelineTimestamps(RECORDS, CUTOFF, NOW, DAY_SEC);
      const servers = [...new Set(RECORDS.map((r) => r.dns_server))];
      for (const server of servers) {
        buildRollingEnvelope(RECORDS, server, timestamps, DAY_SEC);
      }
    },
    { time: 800 },
  );

  bench(
    "buildRollingEnvelope × 2 servers @ 30m",
    () => {
      setDisplayRangeSec(30 * 60);
      const { timestamps } = collectTimelineTimestamps(RECORDS, CUTOFF, NOW, 30 * 60);
      const servers = [...new Set(RECORDS.map((r) => r.dns_server))];
      for (const server of servers) {
        buildRollingEnvelope(RECORDS, server, timestamps, 30 * 60);
      }
    },
    { time: 800 },
  );

  bench(
    "computeStats (full history)",
    () => {
      computeStats(RECORDS);
    },
    { time: 400 },
  );

  bench(
    "buildLatencyChart full pipeline @ 24h",
    () => {
      setDisplayRangeSec(DAY_SEC);
      const { successes, failures } = aggregateByServer(RECORDS);
      buildLatencyChart(RECORDS, successes, failures, CUTOFF);
      destroyChart();
    },
    { time: 800 },
  );

  bench(
    "buildLatencyChart full pipeline @ 30m",
    () => {
      setDisplayRangeSec(30 * 60);
      const { successes, failures } = aggregateByServer(RECORDS);
      buildLatencyChart(RECORDS, successes, failures, CUTOFF);
      destroyChart();
    },
    { time: 800 },
  );
});
