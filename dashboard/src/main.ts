import { Chart, registerables } from "chart.js";
import { buildErrorChart, getErrorChart } from "./charts/error.ts";
import { buildLatencyChart, getLatencyChart } from "./charts/latency.ts";
import { chartRegionsPlugin, errorBandLabelsPlugin } from "./charts/plugins.ts";
import { monitorConfig } from "./config.ts";
import { aggregateByServer, computeStats, filterByPeriod, parseTsv } from "./data.ts";
import {
  allRecords,
  setAllRecords,
  setDataCutoffTs,
  setDisplayRangeSec,
} from "./state.ts";
import { fmtJst } from "./time.ts";
import { initRangeSelector, loadDisplayRangeFromConfig, renderStats } from "./ui.ts";
import "./style.css";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

function render(): void {
  const filtered = filterByPeriod(allRecords, monitorConfig.data_cutoff_ts);
  const { successes, failures } = aggregateByServer(filtered);
  const stats = computeStats(filtered);
  renderStats(stats);
  buildLatencyChart(filtered, successes, failures, monitorConfig.data_cutoff_ts);
  buildErrorChart(stats.errors);
  requestAnimationFrame(resizeCharts);
}

function resizeCharts(): void {
  getLatencyChart()?.resize();
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

    const res = await fetch(`data/dns-latency.tsv?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setAllRecords(parseTsv(await res.text()));
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