import { Chart, registerables } from "chart.js";
import { buildErrorChart, getErrorChart } from "./charts/error.ts";
import {
  buildLatencyChart,
  resizeLatencyChartLayout,
} from "./charts/latency.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./charts/plugins.ts";
import { monitorConfig } from "./config.ts";
import { aggregateByServer, computeStats, filterByPeriod, parseRecordsJson } from "./data.ts";
import {
  allRecords,
  setAllRecords,
  setDataCutoffTs,
  setDisplayRangeSec,
} from "./state.ts";
import { fmtJst, isCompactChartLayout } from "./time.ts";
import { initRangeSelector, loadDisplayRangeFromConfig, renderStats } from "./ui.ts";
import "./style.css";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

let lastCompactLayout = isCompactChartLayout();

function render(): void {
  const filtered = filterByPeriod(allRecords, monitorConfig.data_cutoff_ts);
  const { successes, failures } = aggregateByServer(filtered);
  const stats = computeStats(filtered);
  renderStats(stats);
  buildLatencyChart(filtered, successes, failures, monitorConfig.data_cutoff_ts);
  buildErrorChart(stats.errors);
  lastCompactLayout = isCompactChartLayout();
  requestAnimationFrame(resizeCharts);
}

function resizeCharts(): void {
  const compact = isCompactChartLayout();
  // Tick density / label format differ between compact and PC; rebuild when it flips.
  if (compact !== lastCompactLayout && allRecords.length) {
    render();
    return;
  }
  resizeLatencyChartLayout();
  getErrorChart()?.resize();
}

function initDashboard(): void {
  setDataCutoffTs(monitorConfig.data_cutoff_ts);
  setDisplayRangeSec(loadDisplayRangeFromConfig());
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