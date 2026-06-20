const DEFAULT_DISPLAY_RANGE_SEC = 24 * 3600;
const STORAGE_KEY = "dns-monitor-display-range-sec";
const LEGACY_STORAGE_KEY = "dns-monitor-display-hours";
const RANGE_PRESETS = [
  { seconds: 10 * 60, label: "10m" },
  { seconds: 30 * 60, label: "30m" },
  { seconds: 3600, label: "1h" },
  { seconds: 3 * 3600, label: "3h" },
  { seconds: 6 * 3600, label: "6h" },
  { seconds: 12 * 3600, label: "12h" },
  { seconds: 24 * 3600, label: "24h" },
  { seconds: 72 * 3600, label: "3d" },
  { seconds: 168 * 3600, label: "7d" },
];
const HOUR_SEC = 3600;
const MIN_SEC = 60;
const DAY_SEC = 86400;
const JST_OFFSET = 9 * HOUR_SEC;
const MEASURE_INTERVAL_SEC = 60;
const MAX_GAP_SEC = 3 * 60; // 計測間隔1分 → 3分以上空いたら線を切る
const SERVER_COLORS = ["#5b8def", "#f59e0b", "#4ade80", "#a78bfa", "#f472b6", "#38bdf8"];
const ERROR_COLORS = {
  timeout: "#ef4444",
  no_response: "#f97316",
  no_nameserver: "#f59e0b",
  server_fail: "#eab308",
  refused: "#a855f7",
  nxdomain: "#ec4899",
  no_record: "#6366f1",
  resolver_error: "#14b8a6",
  unknown: "#8b90a0",
};
const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function segmentCrossesTimeout(prevX, nextX, timeoutTs) {
  for (const t of timeoutTs) {
    if (t < nextX && t + MEASURE_INTERVAL_SEC > prevX) return true;
  }
  return false;
}

function withGaps(points, timeoutTs = []) {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prevX = sorted[i - 1].x;
    const nextX = sorted[i].x;
    if (nextX - prevX > MAX_GAP_SEC || segmentCrossesTimeout(prevX, nextX, timeoutTs)) {
      result.push({ x: prevX, y: null });
    }
    result.push(sorted[i]);
  }
  return result;
}

// TSV の ts は Unix 秒（UTC エポック）。表示は常に JST に変換する
const fmtJst = (unixSec) => jstFormatter.format(new Date(unixSec * 1000));

function getDisplayCutoff() {
  const rolling = Math.floor(Date.now() / 1000) - displayRangeSec;
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

function chartTickStep(rangeSec) {
  if (rangeSec <= 10 * MIN_SEC) return 2 * MIN_SEC;
  if (rangeSec <= 30 * MIN_SEC) return 5 * MIN_SEC;
  if (rangeSec <= HOUR_SEC) return 10 * MIN_SEC;
  if (rangeSec <= 6 * HOUR_SEC) return HOUR_SEC;
  if (rangeSec <= 12 * HOUR_SEC) return 2 * HOUR_SEC;
  if (rangeSec <= 24 * HOUR_SEC) return 3 * HOUR_SEC;
  if (rangeSec <= 72 * HOUR_SEC) return 12 * HOUR_SEC;
  return DAY_SEC;
}

function chartTimeBounds() {
  const now = Math.floor(Date.now() / 1000);
  const rangeSec = displayRangeSec;
  const tickStep = chartTickStep(rangeSec);
  let max;
  if (rangeSec > DAY_SEC) {
    max = nextJstDay(now);
  } else if (rangeSec <= HOUR_SEC) {
    max = Math.ceil(now / MIN_SEC) * MIN_SEC;
  } else {
    max = ceilToHour(now);
  }
  return { min: max - rangeSec, max, range: rangeSec, tickStep };
}

function rangeLabel(seconds) {
  return RANGE_PRESETS.find((p) => p.seconds === seconds)?.label ?? `${Math.round(seconds / HOUR_SEC)}h`;
}

function isValidDisplayRangeSec(seconds) {
  return RANGE_PRESETS.some((p) => p.seconds === seconds);
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
    }

    ctx.restore();
  },
};

function withAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function latencyRanges(rawRecords, servers) {
  const serverIndex = new Map(servers.map((server, index) => [server, index]));
  const buckets = new Map();
  for (const r of rawRecords) {
    if (r.error) continue;
    const key = `${r.dns_server}\0${r.ts}`;
    if (!buckets.has(key)) {
      buckets.set(key, { ts: r.ts, dns_server: r.dns_server, values: [] });
    }
    buckets.get(key).values.push(r.latency_ms);
  }

  const ranges = [];
  for (const { ts, dns_server, values } of buckets.values()) {
    if (values.length < 2) continue;
    const idx = serverIndex.get(dns_server) ?? 0;
    ranges.push({
      ts,
      min: Math.min(...values),
      max: Math.max(...values),
      color: SERVER_COLORS[idx % SERVER_COLORS.length],
    });
  }
  return ranges;
}

const latencyRangePlugin = {
  id: "latencyRange",
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    const xScale = scales.x;
    const yScale = scales.y;
    if (!chartArea || !xScale || !yScale) return;

    ctx.save();
    for (const { ts, min, max, color } of opts?.ranges ?? []) {
      const x = xScale.getPixelForValue(ts);
      if (x < chartArea.left || x > chartArea.right) continue;

      const yTop = yScale.getPixelForValue(max);
      const yBottom = yScale.getPixelForValue(min);
      const cap = 3;

      ctx.strokeStyle = withAlpha(color, 0.7);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yBottom);
      ctx.moveTo(x - cap, yTop);
      ctx.lineTo(x + cap, yTop);
      ctx.moveTo(x - cap, yBottom);
      ctx.lineTo(x + cap, yBottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

function readableTextColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1a1d27" : "#fff";
}

const errorBandLabelsPlugin = {
  id: "errorBandLabels",
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    if (opts?.empty) {
      const bar = chart.getDatasetMeta(0)?.data?.[0];
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

    const total = opts?.total ?? 0;
    if (!total) return;

    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    chart.data.datasets.forEach((dataset, index) => {
      const bar = chart.getDatasetMeta(index)?.data?.[0];
      if (!bar) return;

      const left = Math.min(bar.x, bar.base);
      const right = Math.max(bar.x, bar.base);
      const width = right - left;
      const count = dataset.data[0];
      const pct = Math.round((count / total) * 100);
      const label = dataset.label;
      const text = width >= 96 ? `${label} ${count} (${pct}%)`
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

Chart.register(chartRegionsPlugin, errorBandLabelsPlugin, latencyRangePlugin);

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
let displayRangeSec = DEFAULT_DISPLAY_RANGE_SEC;
let allRecords = [];
let latencyChart = null;
let errorChart = null;
let rangeSelectorReady = false;

function isDomainColumn(value) {
  return Boolean(value) && /[a-zA-Z]/.test(value);
}

function parseTsv(text) {
  return text.trim().split("\n").filter((l) => l.trim()).map((line) => {
    const cols = line.split("\t");
    const ts = parseInt(cols[0], 10);
    const dns_server = cols[1];
    if (isDomainColumn(cols[2])) {
      const domain = cols[2];
      if (cols[4]) return { ts, dns_server, domain, error: cols[4] };
      return { ts, dns_server, domain, latency_ms: Number(cols[3]) };
    }
    if (cols.length >= 4 && cols[3]) return { ts, dns_server, domain: null, error: cols[3] };
    return { ts, dns_server, domain: null, latency_ms: Number(cols[2]) };
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

function computeStats(records) {
  const successes = records.filter((r) => !r.error);
  const failures = records.filter((r) => r.error);
  const latencies = successes.map((r) => r.latency_ms);
  const total = records.length;
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

function buildLatencyChart(rawRecords, successes, failures) {
  const servers = [...new Set(rawRecords.filter((r) => !r.error).map((r) => r.dns_server))].sort();
  const datasets = [];

  servers.forEach((server, index) => {
    const color = SERVER_COLORS[index % SERVER_COLORS.length];
    const serverTimeouts = failures
      .filter((r) => r.dns_server === server && r.error === "timeout")
      .map((r) => r.ts);

    datasets.push({
      label: server,
      order: 2,
      data: withGaps(
        successes.filter((r) => r.dns_server === server)
          .map((r) => ({ x: r.ts, y: r.latency_ms })),
        serverTimeouts
      ),
      borderColor: color,
      backgroundColor: color,
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.1,
      fill: false,
      spanGaps: false,
    });

    const samples = rawRecords.filter((r) => !r.error && r.dns_server === server);
    if (samples.length) {
      datasets.push({
        label: `${server} samples`,
        type: "scatter",
        order: 1,
        data: samples.map((r) => ({ x: r.ts, y: r.latency_ms, domain: r.domain })),
        borderColor: color,
        backgroundColor: withAlpha(color, 0.55),
        pointRadius: 3,
        pointHoverRadius: 4,
        showLine: false,
      });
    }
  });

  datasets.push({
    label: "Failures",
    order: 0,
    data: failures.map((r) => ({ x: r.ts, y: 0, error: r.error, dns_server: r.dns_server, domain: r.domain })),
    borderColor: "#f87171",
    backgroundColor: "#f87171",
    pointRadius: 5,
    pointStyle: "crossRot",
    showLine: false,
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
        latencyRange: { ranges: latencyRanges(rawRecords, servers) },
        legend: {
          labels: {
            color: "#e4e6ed",
            filter: (item) => !item.text.endsWith(" samples"),
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => fmtJst(items[0].parsed.x),
            label(ctx) {
              const raw = ctx.raw;
              if (raw.error) {
                const domain = raw.domain ? ` / ${raw.domain}` : "";
                return `${raw.dns_server}${domain}: ${raw.error}`;
              }
              if (raw.domain) return `${raw.domain}: ${Math.round(raw.y)} ms`;
              if (ctx.dataset.label?.endsWith(" samples")) {
                return `${Math.round(raw.y)} ms`;
              }
              return `${ctx.dataset.label} 平均: ${Math.round(raw.y)} ms`;
            },
          },
        },
      },
    },
  });
}

function errorBandRadius(index, count) {
  if (count <= 1) return 6;
  if (index === 0) return { topLeft: 6, bottomLeft: 6, topRight: 0, bottomRight: 0 };
  if (index === count - 1) return { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 };
  return 0;
}

function buildErrorChart(errors) {
  const codes = Object.keys(errors).sort((a, b) => errors[b] - errors[a]);
  const total = codes.reduce((sum, code) => sum + errors[code], 0);
  if (errorChart) errorChart.destroy();

  const datasets = codes.length
    ? codes.map((code, index) => ({
        label: code,
        data: [errors[code]],
        backgroundColor: ERROR_COLORS[code] || SERVER_COLORS[index % SERVER_COLORS.length],
        borderWidth: 0,
        borderRadius: errorBandRadius(index, codes.length),
      }))
    : [{
        label: "なし",
        data: [1],
        backgroundColor: "#2a2e3d",
        borderWidth: 0,
        borderRadius: 6,
      }];

  errorChart = new Chart(document.getElementById("errorChart"), {
    type: "bar",
    data: { labels: [""], datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      datasets: { bar: { barThickness: 36 } },
      scales: {
        x: {
          stacked: true,
          display: false,
          max: codes.length ? total : 1,
        },
        y: {
          stacked: true,
          display: false,
        },
      },
      plugins: {
        errorBandLabels: {
          total,
          empty: !codes.length,
        },
        legend: { display: false },
        tooltip: {
          filter: (item) => codes.length > 0,
          callbacks: {
            label(ctx) {
              const count = ctx.raw;
              const pct = total ? ((count / total) * 100).toFixed(1) : "0.0";
              return `${ctx.dataset.label}: ${count} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function updateRangeUi() {
  document.getElementById("subtitle").textContent =
    `自宅回線の DNS 応答レイテンシ — DNS サーバー別（直近 ${rangeLabel(displayRangeSec)} / データ保持 7 日）`;
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.seconds) === displayRangeSec);
  });
}

function setDisplayRangeSec(seconds) {
  if (!isValidDisplayRangeSec(seconds) || seconds === displayRangeSec) return;
  displayRangeSec = seconds;
  localStorage.setItem(STORAGE_KEY, String(seconds));
  updateRangeUi();
  render();
}

function initRangeSelector() {
  const el = document.getElementById("rangeSelector");
  if (!rangeSelectorReady) {
    el.innerHTML = RANGE_PRESETS.map(
      (p) => `<button type="button" class="range-btn" data-seconds="${p.seconds}">${p.label}</button>`
    ).join("");
    el.addEventListener("click", (e) => {
      const btn = e.target.closest(".range-btn");
      if (!btn) return;
      setDisplayRangeSec(Number(btn.dataset.seconds));
    });
    rangeSelectorReady = true;
  }
  updateRangeUi();
}

function render() {
  const filtered = filterByPeriod(allRecords);
  const { successes, failures } = aggregateByServer(filtered);
  const stats = computeStats(filtered);
  renderStats(stats);
  buildLatencyChart(filtered, successes, failures);
  buildErrorChart(stats.errors);
  requestAnimationFrame(resizeCharts);
}

async function loadConfig() {
  let configDefaultSec = DEFAULT_DISPLAY_RANGE_SEC;
  try {
    const res = await fetch(`config/monitor.json?t=${Date.now()}`);
    if (res.ok) {
      const cfg = await res.json();
      dataCutoffTs = cfg.data_cutoff_ts || 0;
      configDefaultSec = (cfg.display_hours || 24) * HOUR_SEC;
    }
  } catch {
    dataCutoffTs = 0;
  }

  const storedSec = Number(localStorage.getItem(STORAGE_KEY));
  if (isValidDisplayRangeSec(storedSec)) {
    displayRangeSec = storedSec;
    return;
  }

  const legacyHours = Number(localStorage.getItem(LEGACY_STORAGE_KEY));
  if (isValidDisplayRangeSec(legacyHours * HOUR_SEC)) {
    displayRangeSec = legacyHours * HOUR_SEC;
    localStorage.setItem(STORAGE_KEY, String(displayRangeSec));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return;
  }

  displayRangeSec = isValidDisplayRangeSec(configDefaultSec)
    ? configDefaultSec
    : DEFAULT_DISPLAY_RANGE_SEC;
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