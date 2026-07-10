import { DAY_SEC, HIDE_LATENCY_POINTS_RANGE_SEC, HOUR_SEC, MIN_SEC } from "../constants.ts";
import { displayRangeSec } from "../state.ts";
import type { ChartPoint, DnsRecord, DnsSuccessRecord } from "../types.ts";

const MIN_SAMPLES = 2;

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

export function envelopeWindowSec(rangeSec: number = displayRangeSec): number {
  if (rangeSec < HIDE_LATENCY_POINTS_RANGE_SEC) return 0;
  if (rangeSec <= 6 * HOUR_SEC) return 10 * MIN_SEC;
  if (rangeSec <= 24 * HOUR_SEC) return HOUR_SEC;
  return DAY_SEC;
}

/** First index i with sorted[i] >= target. */
export function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i with sorted[i] > target. */
export function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * min / max / mean / sample-std over latencies[start..end) without full sort
 * (boxplot was O(w log w) per anchor and dominated render time).
 */
export function windowMoments(
  latencies: readonly number[],
  start: number,
  end: number,
): { min: number; max: number; mean: number; std: number; count: number } | null {
  const n = end - start;
  if (n <= 0) return null;
  let min = latencies[start];
  let max = latencies[start];
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = latencies[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;
  if (n < 2) {
    return { min, max, mean, std: 0, count: n };
  }
  let varSum = 0;
  for (let i = start; i < end; i++) {
    const d = latencies[i] - mean;
    varSum += d * d;
  }
  // Population variance matches previous boxplot.variance usage for σ band width.
  const std = Math.sqrt(varSum / n);
  return { min, max, mean, std, count: n };
}

function momentsFromValues(values: readonly number[]): {
  min: number;
  max: number;
  mean: number;
  std: number;
  count: number;
} | null {
  return windowMoments(values, 0, values.length);
}

/**
 * Build X anchors for the rolling envelope across [min, max].
 * Density targets ~`pointsPerViewport` samples inside one selected-range window so bands
 * stay sharp when panning multi-day history (a flat 400-point cap over a week looked too smooth).
 */
export function collectTimelineTimestamps(
  records: DnsRecord[],
  min: number,
  max: number,
  viewportSec: number = displayRangeSec,
  pointsPerViewport = 240,
): { timestamps: number[]; step: number } {
  const ts = new Set<number>();
  for (const r of records) {
    if (r.ts >= min && r.ts <= max) ts.add(r.ts);
  }
  const sorted = [...ts].sort((a, b) => a - b);
  if (!sorted.length) return { timestamps: [], step: 1 };

  const spanSec = Math.max(1, max - min);
  const vp = Math.max(1, viewportSec);
  // Short zooms use per-batch bands — keep nearly every minute for a week of data.
  // Longer zooms use a rolling window and can afford more downsampling.
  const hardCap = vp < HIDE_LATENCY_POINTS_RANGE_SEC ? 12_000 : 5_000;
  const maxPoints = Math.min(
    hardCap,
    Math.max(pointsPerViewport, Math.ceil(pointsPerViewport * (spanSec / vp))),
  );
  if (sorted.length <= maxPoints) return { timestamps: sorted, step: 1 };
  const step = Math.ceil(sorted.length / maxPoints);
  return { timestamps: sorted.filter((_, index) => index % step === 0), step };
}

export interface RollingEnvelope {
  min: ChartPoint[];
  max: ChartPoint[];
  meanLow: ChartPoint[];
  meanHigh: ChartPoint[];
  emptyTimestamps: number[];
}

/** Sorted parallel arrays for one resolver (built once per envelope). */
export function indexSuccessesByServer(
  rawRecords: DnsRecord[],
  server: string,
): { ts: number[]; latency: number[] } {
  const pairs: { ts: number; latency: number }[] = [];
  for (const r of rawRecords) {
    if (isSuccess(r) && r.dns_server === server) {
      pairs.push({ ts: r.ts, latency: r.latency_ms });
    }
  }
  pairs.sort((a, b) => a.ts - b.ts || a.latency - b.latency);
  return {
    ts: pairs.map((p) => p.ts),
    latency: pairs.map((p) => p.latency),
  };
}

export function buildRollingEnvelope(
  rawRecords: DnsRecord[],
  server: string,
  timestamps: number[],
  rangeSec: number = displayRangeSec,
): RollingEnvelope {
  const windowSec = envelopeWindowSec(rangeSec);
  const { ts: successTs, latency: successLat } = indexSuccessesByServer(rawRecords, server);

  const min: ChartPoint[] = [];
  const max: ChartPoint[] = [];
  const meanLow: ChartPoint[] = [];
  const meanHigh: ChartPoint[] = [];
  const emptyTimestamps: number[] = [];

  if (!successTs.length) {
    for (const t of timestamps) emptyTimestamps.push(t);
    return { min, max, meanLow, meanHigh, emptyTimestamps };
  }

  if (windowSec <= 0) {
    // Same-timestamp batches only: group once, then O(1) lookup per anchor.
    const byTs = new Map<number, number[]>();
    for (let i = 0; i < successTs.length; i++) {
      const t = successTs[i];
      let bucket = byTs.get(t);
      if (!bucket) {
        bucket = [];
        byTs.set(t, bucket);
      }
      bucket.push(successLat[i]);
    }
    for (const t of timestamps) {
      const values = byTs.get(t);
      if (!values || !values.length) {
        emptyTimestamps.push(t);
        continue;
      }
      if (values.length < MIN_SAMPLES) continue;
      const stats = momentsFromValues(values);
      if (!stats) continue;
      min.push({ x: t, y: stats.min });
      max.push({ x: t, y: stats.max });
      meanLow.push({ x: t, y: Math.max(0, stats.mean - stats.std) });
      meanHigh.push({ x: t, y: stats.mean + stats.std });
    }
    return { min, max, meanLow, meanHigh, emptyTimestamps };
  }

  // Rolling window: binary search bounds on sorted success timestamps.
  const half = windowSec / 2;
  for (const t of timestamps) {
    const lo = lowerBound(successTs, t - half);
    const hi = upperBound(successTs, t + half);
    if (hi <= lo) {
      emptyTimestamps.push(t);
      continue;
    }
    if (hi - lo < MIN_SAMPLES) continue;
    const stats = windowMoments(successLat, lo, hi);
    if (!stats) continue;
    min.push({ x: t, y: stats.min });
    max.push({ x: t, y: stats.max });
    meanLow.push({ x: t, y: Math.max(0, stats.mean - stats.std) });
    meanHigh.push({ x: t, y: stats.mean + stats.std });
  }

  return { min, max, meanLow, meanHigh, emptyTimestamps };
}
