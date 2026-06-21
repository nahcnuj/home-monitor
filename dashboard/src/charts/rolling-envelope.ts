import { boxplot } from "@sgratzl/boxplots";
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

function latencyValuesInWindow(
  successes: DnsSuccessRecord[],
  anchorTs: number,
  windowSec: number,
): number[] {
  if (windowSec <= 0) {
    return successes.filter((r) => r.ts === anchorTs).map((r) => r.latency_ms);
  }

  const half = windowSec / 2;
  return successes
    .filter((r) => r.ts >= anchorTs - half && r.ts <= anchorTs + half)
    .map((r) => r.latency_ms);
}

export function collectTimelineTimestamps(records: DnsRecord[], min: number, max: number): number[] {
  const ts = new Set<number>();
  for (const r of records) {
    if (r.ts >= min && r.ts <= max) ts.add(r.ts);
  }
  const sorted = [...ts].sort((a, b) => a - b);
  const maxPoints = 400;
  if (sorted.length <= maxPoints) return sorted;
  const step = Math.ceil(sorted.length / maxPoints);
  return sorted.filter((_, index) => index % step === 0);
}

export interface RollingEnvelope {
  min: ChartPoint[];
  max: ChartPoint[];
  q1: ChartPoint[];
  q3: ChartPoint[];
}

export function buildRollingEnvelope(
  rawRecords: DnsRecord[],
  server: string,
  timestamps: number[],
  rangeSec: number = displayRangeSec,
): RollingEnvelope {
  const windowSec = envelopeWindowSec(rangeSec);
  const successes = rawRecords.filter(
    (r): r is DnsSuccessRecord => isSuccess(r) && r.dns_server === server,
  );

  const min: ChartPoint[] = [];
  const max: ChartPoint[] = [];
  const q1: ChartPoint[] = [];
  const q3: ChartPoint[] = [];

  for (const ts of timestamps) {
    const values = latencyValuesInWindow(successes, ts, windowSec);
    if (values.length < MIN_SAMPLES) continue;

    const stats = boxplot(values);
    min.push({ x: ts, y: stats.min });
    max.push({ x: ts, y: stats.max });
    q1.push({ x: ts, y: stats.q1 });
    q3.push({ x: ts, y: stats.q3 });
  }

  return { min, max, q1, q3 };
}