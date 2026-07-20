import { Chart, registerables } from "chart.js";
import { buildErrorChart, getErrorChart } from "./charts/error.ts";
import {
  buildLatencyChart,
  getVisibleTimeWindow,
  isLatencyScrollMode,
  resizeLatencyChartLayout,
  setOnVisibleWindowChange,
} from "./charts/latency.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./charts/plugins.ts";
import { monitorConfig } from "./config.ts";
import {
  aggregateByServer,
  computeStats,
  filterByPeriod,
  filterByTimeWindow,
  parseRecordsJson,
} from "./data.ts";
import {
  allRecords,
  setAllRecords,
  setDataCutoffTs,
  setDisplayRangeSec,
} from "./state.ts";
import { fmtJst, isCompactChartLayout } from "./time.ts";
import type { DnsRecord } from "./types.ts";
import { initRangeSelector, loadDisplayRangeFromConfig, renderStats } from "./ui.ts";
import "./style.css";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

let lastCompactLayout = isCompactChartLayout();
let renderScheduled = false;
/** Records after data_cutoff (full chart history); metrics use a visible slice of this. */
let chartRecords: DnsRecord[] = [];

function updateMetricsForVisibleWindow(min: number, max: number): void {
  const stats = computeStats(filterByTimeWindow(chartRecords, min, max));
  renderStats(stats);
  buildErrorChart(stats.errors);
}

function render(): void {
  chartRecords = filterByPeriod(allRecords, monitorConfig.data_cutoff_ts);
  const { successes, failures } = aggregateByServer(chartRecords);
  buildLatencyChart(chartRecords, successes, failures, monitorConfig.data_cutoff_ts);
  // Chart build pins the view to the latest viewport; metrics match that window.
  const { min, max } = getVisibleTimeWindow();
  updateMetricsForVisibleWindow(min, max);
  lastCompactLayout = isCompactChartLayout();
  requestAnimationFrame(resizeCharts);
}

function scheduleRender(): void {
  if (renderScheduled || !allRecords.length) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function resizeCharts(): void {
  const compact = isCompactChartLayout();
  // Tick density / label format differ between compact and PC; rebuild when it flips.
  if (compact !== lastCompactLayout && allRecords.length) {
    scheduleRender();
    return;
  }
  const wasScroll = isLatencyScrollMode();
  // Keep (or restore) the latest viewport after reflow — range changes rebuild via render.
  resizeLatencyChartLayout(false);
  // Entering/leaving scroll mode toggles legend placement and Y-axis options.
  // Defer rebuild so we never recurse render → resize → render on the same stack.
  if (wasScroll !== isLatencyScrollMode() && allRecords.length) {
    scheduleRender();
    return;
  }
  getErrorChart()?.resize();
}

function initDashboard(): void {
  setDataCutoffTs(monitorConfig.data_cutoff_ts);
  setDisplayRangeSec(loadDisplayRangeFromConfig());
  setOnVisibleWindowChange(updateMetricsForVisibleWindow);
  initRangeSelector(render);
}

async function loadData(): Promise<void> {
  const lastUpdated = document.getElementById("lastUpdated");
  try {
    initDashboard();

    const res = await fetch(`data/dns-latency.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setAllRecords(parseRecordsJson(await res.text()));
    if (lastUpdated) {
      lastUpdated.textContent = allRecords.length
        ? `最終データ: ${fmtJst(allRecords.at(-1)!.ts)}（JST）`
        : "データなし";
    }
    render();
  } catch (err) {
    if (lastUpdated) {
      lastUpdated.textContent = `読み込みエラー: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

loadData();
setInterval(loadData, 30 * 60 * 1000);
window.addEventListener("resize", resizeCharts);
