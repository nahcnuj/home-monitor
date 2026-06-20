import { MEASURE_INTERVAL_SEC } from "./constants.ts";
import type { DnsRecord, DnsSuccessRecord, ViolinBucket, ViolinSeries } from "./types.ts";
import { withAlpha } from "./utils.ts";

const KERNEL_STEPS = 28;

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

export function latencyViolinBuckets(rawRecords: DnsRecord[], server: string): ViolinBucket[] {
  const buckets = new Map<number, number[]>();

  for (const r of rawRecords.filter(isSuccess)) {
    if (r.dns_server !== server) continue;
    if (!buckets.has(r.ts)) buckets.set(r.ts, []);
    buckets.get(r.ts)!.push(r.latency_ms);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, values]) => ({ ts, values }));
}

export function latencyValuesAt(
  rawRecords: DnsRecord[],
  server: string,
  ts: number,
): number[] {
  return rawRecords
    .filter((r): r is DnsSuccessRecord => isSuccess(r) && r.dns_server === server && r.ts === ts)
    .map((r) => r.latency_ms);
}

export function buildViolinSeries(
  rawRecords: DnsRecord[],
  servers: string[],
  colors: readonly string[],
  timeoutTsByServer: Map<string, Set<number>>,
): ViolinSeries[] {
  const offsetStep = MEASURE_INTERVAL_SEC * 0.12;

  return servers.map((server, index) => ({
    dns_server: server,
    color: colors[index % colors.length],
    xOffsetSec: (index - (servers.length - 1) / 2) * offsetStep,
    skipTs: timeoutTsByServer.get(server) ?? new Set(),
    buckets: latencyViolinBuckets(rawRecords, server),
  }));
}

function violinBandwidth(values: number[]): number {
  if (values.length < 2) return 4;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  const range = Math.max(...values) - Math.min(...values);
  const silverman = 1.06 * std * values.length ** -0.2;
  return Math.max(2, Math.min(range * 0.4 || 4, silverman || 4));
}

function gaussianKde(y: number, values: number[], bandwidth: number): number {
  const norm = 1 / (bandwidth * Math.sqrt(2 * Math.PI));
  let sum = 0;
  for (const value of values) {
    const z = (y - value) / bandwidth;
    sum += Math.exp(-0.5 * z * z);
  }
  return (sum / values.length) * norm;
}

export function drawViolin(
  ctx: CanvasRenderingContext2D,
  cx: number,
  values: number[],
  yToPixel: (y: number) => number,
  halfWidthPx: number,
  color: string,
): void {
  if (!values.length) return;

  const bandwidth = violinBandwidth(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = values.length === 1 ? bandwidth : bandwidth * 1.5;
  const yStart = min - pad;
  const yEnd = max + pad;

  const densities: number[] = [];
  for (let i = 0; i <= KERNEL_STEPS; i++) {
    const y = yStart + ((yEnd - yStart) * i) / KERNEL_STEPS;
    densities.push(gaussianKde(y, values, bandwidth));
  }
  const peak = Math.max(...densities, 1e-9);

  ctx.beginPath();
  for (let i = 0; i <= KERNEL_STEPS; i++) {
    const y = yStart + ((yEnd - yStart) * i) / KERNEL_STEPS;
    const w = (densities[i] / peak) * halfWidthPx;
    const py = yToPixel(y);
    if (i === 0) ctx.moveTo(cx + w, py);
    else ctx.lineTo(cx + w, py);
  }
  for (let i = KERNEL_STEPS; i >= 0; i--) {
    const y = yStart + ((yEnd - yStart) * i) / KERNEL_STEPS;
    const w = (densities[i] / peak) * halfWidthPx;
    ctx.lineTo(cx - w, yToPixel(y));
  }
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.28);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();
}