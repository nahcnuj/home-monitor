const DEFAULT_DISPLAY_HOURS = 24;
const STORAGE_KEY = "dns-monitor-display-hours";
const RANGE_PRESETS = [
  { hours: 3, label: "3h" },
  { hours: 6, label: "6h" },
  { hours: 12, label: "12h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "3d" },
  { hours: 168, label: "7d" },
];
const HOUR_SEC = 3600;
const DAY_SEC = 86400;
const JST_OFFSET = 9 * HOUR_SEC;
const MEASURE_INTERVAL_SEC = 60;
const MAX_GAP_SEC = 3 * 60; // 計測間隔1分 → 3分以上空いたら線を切る
const SERVER_COLORS = ["#5b8def", "#f59e0b", "#4ade80", "#a78bfa", "#f472b6", "#38bdf8"];
const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function withGaps(points) {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - sorted[i - 1].x > MAX_GAP_SEC) {
      result.push({ x: sorted[i - 1].x, y: null });
    }
    result.push(sorted[i]);
  }
  return result;
}

// TSV の ts は Unix 秒（UTC エポック）。表示は常に JST に変換する
const fmtJst = (unixSec) => jstFormatter.format(new Date(unixSec * 1000));

function getDisplayCutoff() {
  const rolling = Math.floor(Date.now() / 1000) - displayHours * HOUR_SEC;
  return Math.max(rolling, dataCutoffTs);
}

function floorToJstDay(unixSec) {
  return Math.floor((unixSec + JST_OFFSET) / DAY_SEC) * DAY_SEC - JST_OFFSET;
}

function nextJstDay(unixSec) {
  return floorToJstDay(unixSec) + DAY_SEC;
}

function ceilToHour(unixSec) {
  return Math.ceil(unixSec / HOUR_SEC) * HOUR_SEC;
}

function chartTickStep(hours) {
  if (hours <= 6) return HOUR_SEC;
  if (hours <= 12) return 2 * HOUR_SEC;
  if (hours <= 24) return 3 * HOUR_SEC;
  if (hours <= 72) return 12 * HOUR_SEC;
  return DAY_SEC;
}

function chartTimeBounds() {
  const now = Math.floor(Date.now() / 1000);
  const rangeSec = displayHours * HOUR_SEC;
  const tickStep = chartTickStep(displayHours);
  if (rangeSec > DAY_SEC) {
    const max = nextJstDay(now);
    return { min: max - rangeSec, max, range: rangeSec, tickStep };
  }
  const max = ceilToHour(now);
  return { min: max - rangeSec, max, range: rangeSec, tickStep };
}

function rangeLabel(hours) {
  return RANGE_PRESETS.find((p) => p.hours === hours)?.label ?? `${hours}h`;
}

function isValidDisplayHours(hours) {
  return RANGE_PRESETS.some((p) => p.hours === hours);
}

function fmtAxisTick(unixSec, tickStep) {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    ...(tickStep < DAY_SEC ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
  return fmt.format(new Date(unixSec * 1000));
}

const chartRegionsPlugin = {
  id: "chartRegions",
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea } = chart;
    const xScale = chart.scales.x;
    if (!chartArea || !xScale) return;

    ctx.save();

    const cutoffEnd = opts?.cutoffEnd ?? 0;
    const xMin = opts?.xMin ?? xScale.min;
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

    for (const { start, end } of opts?.timeoutRanges ?? []) {
      let left = xScale.getPixelForValue(start);
      let right = xScale.getPixelForValue(end);
      left = Math.max(left, chartArea.left);
      right = Math.min(right, chartArea.right);
      if (right <= left) continue;

      ctx.fillStyle = "rgba(248, 113, 113, 0.28)";
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);

      ctx.fillStyle = "rgba(248, 113, 113, 0.55)";
      ctx.fillRect(left, chartArea.top, 2, chartArea.bottom - chartArea.top);
      ctx.fillRect(right - 2, chartArea.top, 2, chartArea.bottom - chartArea.top);
    }

    ctx.restore();
  },
};

Chart.register(chartRegionsPlugin);

function timeoutRanges(failures) {
  const seen = new Set();
  const ranges = [];
  for (const f of failures) {
    if (f.error !== "timeout" || seen.has(f.ts)) continue;
    seen.add(f.ts);
    ranges.push({ start: f.ts, end: f.ts + MEASURE_INTERVAL_SEC });
  }
  return ranges;
}

let dataCutoffTs = 0;
let displayHours = DEFAULT_DISPLAY_HOURS;
let allRecords = [];
let latencyChart = null;
let errorChart = null;
let rangeSelectorReady = false;

function parseTsv(text) {
  return text.trim().split("\n").filter((l) => l.trim()).map((line) => {
    const cols = line.split("\t");
    const ts = parseInt(cols[0], 10);
    const dns_server = cols[1];
    if (cols.length >= 4 && cols[3]) return { ts, dns_server, error: cols[3] };
    return { ts, dns_server, latency_ms: Number(cols[2]) };
  });
}

function aggregateByServer(records) {
  const successBuckets = new Map();
  const failureBuckets = new Map();

  for (const r of records) {
    const key = `${r.dns_server}\0${r.ts}`;
    if (r.error) {
      if (!failureBuckets.has(key)) failureBuckets.set(key, r);
      continue;
    }
    if (!successBuckets.has(key)) {
      successBuckets.set(key, { dns_server: r.dns_server, ts: r.ts, sum: 0, count: 0 });
    }
    const bucket = successBuckets.get(key);
    bucket.sum += r.latency_ms;
    bucket.count += 1;
  }

  const successes = [...successBuckets.values()].map((bucket) => ({
    dns_server: bucket.dns_server,
    ts: bucket.ts,
    latency_ms: bucket.sum / bucket.count,
  }));
  const failures = [...failureBuckets.values()];

  return { successes, failures };
}

function filterByPeriod(records) {
  return records.filter((r) => r.ts >= getDisplayCutoff());
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function computeStats(successes, failures) {
  const latencies = successes.map((r) => r.latency_ms);
  const total = successes.length + failures.length;
  return {
    total,
    failureRate: total ? (failures.length / total) * 100 : 0,
    avg: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p95: percentile(latencies, 95),
    max: latencies.length ? Math.max(...latencies) : 0,
    errors: failures.reduce((acc, r) => { acc[r.error] = (acc[r.error] || 0) + 1; return acc; }, {}),
  };
}

function renderStats(stats) {
  document.getElementById("statsGrid").innerHTML = [
    { label: "測定数", value: stats.total.toLocaleString() },
    { label: "平均 (ms)", value: stats.avg ? Math.round(stats.avg) : "-" },
    { label: "P95 (ms)", value: stats.p95 ? Math.round(stats.p95) : "-" },
    { label: "最大 (ms)", value: stats.max || "-" },
    { label: "失敗率", value: stats.total ? `${stats.failureRate.toFixed(1)}%` : "-", cls: stats.failureRate > 5 ? "error-rate" : "ok" },
  ].map((item) => `
    <div class="stat-card">
      <div class="label">${item.label}</div>
      <div class="value ${item.cls || ""}">${item.value}</div>
    </div>`).join("");
}

function buildLatencyChart(successes, failures) {
  const servers = [...new Set(successes.map((r) => r.dns_server))].sort();
  const datasets = servers.map((server, index) => ({
    label: server,
    data: withGaps(
      successes.filter((r) => r.dns_server === server)
        .map((r) => ({ x: r.ts, y: r.latency_ms }))
    ),
    borderColor: SERVER_COLORS[index % SERVER_COLORS.length],
    backgroundColor: SERVER_COLORS[index % SERVER_COLORS.length],
    pointRadius: 1.5, borderWidth: 1.5, tension: 0.1, fill: false, spanGaps: false,
  }));
  datasets.push({
    label: "Failures",
    data: failures.map((r) => ({ x: r.ts, y: 0, error: r.error, dns_server: r.dns_server })),
    borderColor: "#f87171", backgroundColor: "#f87171",
    pointRadius: 5, pointStyle: "crossRot", showLine: false,
  });

  const xBounds = chartTimeBounds();

  if (latencyChart) latencyChart.destroy();
  latencyChart = new Chart(document.getElementById("latencyChart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: xBounds.min,
          max: xBounds.max,
          grid: { color: "#2a2e3d" },
          ticks: {
            color: "#8b90a0",
            stepSize: xBounds.tickStep,
            autoSkip: false,
            maxRotation: 0,
            callback: (value) => fmtAxisTick(value, xBounds.tickStep),
          },
        },
        y: { title: { display: true, text: "ms", color: "#8b90a0" }, grid: { color: "#2a2e3d" }, ticks: { color: "#8b90a0" }, min: 0 },
      },
      plugins: {
        chartRegions: {
          xMin: xBounds.min,
          cutoffEnd: dataCutoffTs > xBounds.min ? dataCutoffTs : 0,
          timeoutRanges: timeoutRanges(failures),
        },
        legend: { labels: { color: "#e4e6ed" } },
        tooltip: {
          callbacks: {
            title: (items) => fmtJst(items[0].parsed.x),
            label(ctx) {
              const raw = ctx.raw;
              return raw.error ? `${raw.dns_server}: ${raw.error}` : `${ctx.dataset.label}: ${Math.round(raw.y)} ms`;
            },
          },
        },
      },
    },
  });
}

function buildErrorChart(errors) {
  const codes = Object.keys(errors).sort((a, b) => errors[b] - errors[a]);
  if (errorChart) errorChart.destroy();
  errorChart = new Chart(document.getElementById("errorChart"), {
    type: "bar",
    data: {
      labels: codes.length ? codes : ["なし"],
      datasets: [{ data: codes.length ? codes.map((c) => errors[c]) : [0], backgroundColor: "#f87171", borderRadius: 4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b90a0", stepSize: 1 }, grid: { color: "#2a2e3d" } },
        y: { ticks: { color: "#8b90a0" }, grid: { display: false } },
      },
    },
  });
}

function updateRangeUi() {
  document.getElementById("subtitle").textContent =
    `自宅回線の DNS 応答レイテンシ — DNS サーバー別（直近 ${rangeLabel(displayHours)} / データ保持 7 日）`;
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.hours) === displayHours);
  });
}

function setDisplayHours(hours) {
  if (!isValidDisplayHours(hours) || hours === displayHours) return;
  displayHours = hours;
  localStorage.setItem(STORAGE_KEY, String(hours));
  updateRangeUi();
  render();
}

function initRangeSelector() {
  const el = document.getElementById("rangeSelector");
  if (!rangeSelectorReady) {
    el.innerHTML = RANGE_PRESETS.map(
      (p) => `<button type="button" class="range-btn" data-hours="${p.hours}">${p.label}</button>`
    ).join("");
    el.addEventListener("click", (e) => {
      const btn = e.target.closest(".range-btn");
      if (!btn) return;
      setDisplayHours(Number(btn.dataset.hours));
    });
    rangeSelectorReady = true;
  }
  updateRangeUi();
}

function render() {
  const filtered = filterByPeriod(allRecords);
  const { successes, failures } = aggregateByServer(filtered);
  const stats = computeStats(successes, failures);
  renderStats(stats);
  buildLatencyChart(successes, failures);
  buildErrorChart(stats.errors);
  requestAnimationFrame(resizeCharts);
}

async function loadConfig() {
  let configDefault = DEFAULT_DISPLAY_HOURS;
  try {
    const res = await fetch(`config/monitor.json?t=${Date.now()}`);
    if (res.ok) {
      const cfg = await res.json();
      dataCutoffTs = cfg.data_cutoff_ts || 0;
      configDefault = cfg.display_hours || DEFAULT_DISPLAY_HOURS;
    }
  } catch {
    dataCutoffTs = 0;
  }

  const stored = Number(localStorage.getItem(STORAGE_KEY));
  displayHours = isValidDisplayHours(stored)
    ? stored
    : (isValidDisplayHours(configDefault) ? configDefault : DEFAULT_DISPLAY_HOURS);
}

async function loadData() {
  try {
    await loadConfig();
    initRangeSelector();

    const res = await fetch(`data/dns-latency.tsv?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allRecords = parseTsv(await res.text());
    document.getElementById("lastUpdated").textContent = allRecords.length
      ? `最終データ: ${fmtJst(allRecords.at(-1).ts)}（JST）`
      : "データなし";
    render();
  } catch (err) {
    document.getElementById("lastUpdated").textContent = `読み込みエラー: ${err.message}`;
  }
}

function resizeCharts() {
  latencyChart?.resize();
  errorChart?.resize();
}

loadData();
setInterval(loadData, 30 * 60 * 1000);
window.addEventListener("resize", resizeCharts);