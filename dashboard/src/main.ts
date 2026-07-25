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
import {
  initRangeSelector,
  loadDisplayRangeFromConfig,
  renderStats,
  renderViewMeta,
} from "./ui.ts";
import "./style.css";

Chart.register(...registerables, chartRegionsPlugin, errorBandLabelsPlugin);

let lastCompactLayout = isCompactChartLayout();
let renderScheduled = false;
/** Records after data_cutoff; metrics use the visible chart window. */
let chartRecords: DnsRecord[] = [];

function updateMetricsForVisibleWindow(min: number, max: number): void {
  renderViewMeta(min, max);
  const stats = computeStats(filterByTimeWindow(chartRecords, min, max));
  renderStats(stats);
  buildErrorChart(stats.errors);
}

function render(): void {
  chartRecords = filterByPeriod(allRecords, monitorConfig.data_cutoff_ts);
  const { successes, failures } = aggregateByServer(chartRecords);
  buildLatencyChart(chartRecords, successes, failures, monitorConfig.data_cutoff_ts);
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
  if (compact !== lastCompactLayout && allRecords.length) {
    scheduleRender();
    return;
  }
  const wasScroll = isLatencyScrollMode();
  resizeLatencyChartLayout(false);
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

function setStatus(el: HTMLElement | null, text: string, isError = false): void {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-error", isError);
}

async function loadData(): Promise<void> {
  const lastUpdated = document.getElementById("lastUpdated");
  try {
    initDashboard();
    setStatus(lastUpdated, "読み込み中...");

    const res = await fetch(`data/dns-latency.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setAllRecords(parseRecordsJson(await res.text()));
    if (!allRecords.length) {
      setStatus(lastUpdated, "データなし");
    } else {
      setStatus(lastUpdated, `最終データ: ${fmtJst(allRecords.at(-1)!.ts)}（JST）`);
    }
    render();
  } catch (err) {
    setStatus(
      lastUpdated,
      `読み込みエラー: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

loadData();
setInterval(loadData, 30 * 60 * 1000);
window.addEventListener("resize", resizeCharts);
