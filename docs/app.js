const PERIOD_HOURS = 168;
const DOMAIN_COLORS = { "google.com": "#5b8def", "cloudflare.com": "#f59e0b" };

let allRecords = [];
let latencyChart = null;
let errorChart = null;

function parseTsv(text) {
  return text.trim().split("\n").filter((l) => l.trim()).map((line) => {
    const cols = line.split("\t");
    const ts = Number(cols[0]);
    const domain = cols[1];
    if (cols.length >= 4 && cols[3]) return { ts, domain, error: cols[3] };
    return { ts, domain, latency_ms: Number(cols[2]) };
  });
}

function filterByPeriod(records) {
  const cutoff = Math.floor(Date.now() / 1000) - PERIOD_HOURS * 3600;
  return records.filter((r) => r.ts >= cutoff);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function computeStats(records) {
  const successes = records.filter((r) => !isNaN(r.latency_ms));
  const failures = records.filter((r) => r.error);
  const latencies = successes.map((r) => r.latency_ms);
  return {
    total: records.length,
    failureRate: records.length ? (failures.length / records.length) * 100 : 0,
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

function buildLatencyChart(records) {
  const domains = [...new Set(records.map((r) => r.domain))];
  const failures = records.filter((r) => r.error);
  const datasets = domains.map((domain) => ({
    label: domain,
    data: records.filter((r) => r.domain === domain && !isNaN(r.latency_ms))
      .map((r) => ({ x: r.ts * 1000, y: r.latency_ms })),
    borderColor: DOMAIN_COLORS[domain] || "#a78bfa",
    backgroundColor: DOMAIN_COLORS[domain] || "#a78bfa",
    pointRadius: 1.5, borderWidth: 1.5, tension: 0.1, fill: false,
  }));
  datasets.push({
    label: "Failures",
    data: failures.map((r) => ({ x: r.ts * 1000, y: 0, error: r.error, domain: r.domain })),
    borderColor: "#f87171", backgroundColor: "#f87171",
    pointRadius: 5, pointStyle: "crossRot", showLine: false,
  });

  if (latencyChart) latencyChart.destroy();
  latencyChart = new Chart(document.getElementById("latencyChart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: { type: "time", grid: { color: "#2a2e3d" }, ticks: { color: "#8b90a0", maxTicksLimit: 8 } },
        y: { title: { display: true, text: "ms", color: "#8b90a0" }, grid: { color: "#2a2e3d" }, ticks: { color: "#8b90a0" }, min: 0 },
      },
      plugins: {
        legend: { labels: { color: "#e4e6ed" } },
        tooltip: {
          callbacks: {
            label(ctx) {
              const raw = ctx.raw;
              return raw.error ? `${raw.domain}: ${raw.error}` : `${ctx.dataset.label}: ${raw.y} ms`;
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

function render() {
  const filtered = filterByPeriod(allRecords);
  const stats = computeStats(filtered);
  renderStats(stats);
  buildLatencyChart(filtered);
  buildErrorChart(stats.errors);
}

async function loadData() {
  try {
    const res = await fetch(`data/dns-latency.tsv?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allRecords = parseTsv(await res.text());
    document.getElementById("lastUpdated").textContent = allRecords.length
      ? `最終データ: ${new Date(allRecords.at(-1).ts * 1000).toLocaleString("ja-JP")}`
      : "データなし";
    render();
  } catch (err) {
    document.getElementById("lastUpdated").textContent = `読み込みエラー: ${err.message}`;
  }
}

loadData();
setInterval(loadData, 30 * 60 * 1000);