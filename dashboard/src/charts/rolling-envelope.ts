import { boxplot } from "@sgratzl/boxplots";
import { displayRangeSec } from "../state.ts";
import type { ChartPoint, DnsRecord, DnsSuccessRecord } from "../types.ts";
import type { TimeoutSpan } from "../utils.ts";

const MIN_SAMPLES = 2;

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

function spansCoverTs(spans: TimeoutSpan[], ts: number): boolean {
  return spans.some((span) => ts >= span.start && ts < span.end);
}

export function rollingWindowSec(): number {
  const range = displayRangeSec;
  if (range <= 3600) return 10 * 60;
  if (range <= 6 * 3600) return 20 * 60;
  if (range <= 24 * 3600) return 30 * 60;
  if (range <= 72 * 3600) return 60 * 60;
  return 2 * 60 * 60;
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

/** Per-measurement batch (same ts, all domains). Band uses min/max; q1/q3 kept for tests. */
export function buildRollingEnvelope(
  rawRecords: DnsRecord[],
  server: string,
  timestamps: number[],
  spans: TimeoutSpan[],
): RollingEnvelope {
  const successes = rawRecords.filter(
    (r): r is DnsSuccessRecord => isSuccess(r) && r.dns_server === server,
  );

  const min: ChartPoint[] = [];
  const max: ChartPoint[] = [];
  const q1: ChartPoint[] = [];
  const q3: ChartPoint[] = [];

  for (const ts of timestamps) {
    if (spansCoverTs(spans, ts)) continue;

    const values = successes
      .filter((r) => r.ts === ts)
      .map((r) => r.latency_ms);
    if (values.length < MIN_SAMPLES) continue;

    const stats = boxplot(values);
    min.push({ x: ts, y: stats.min });
    max.push({ x: ts, y: stats.max });
    q1.push({ x: ts, y: stats.q1 });
    q3.push({ x: ts, y: stats.q3 });
  }

  return { min, max, q1, q3 };
}