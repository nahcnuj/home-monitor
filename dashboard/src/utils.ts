import { monitorConfig } from "./config.ts";
import { MAX_GAP_SEC } from "./constants.ts";
import { isTimeoutError } from "./errors.ts";
import type { ChartPoint, DnsFailureRecord, DnsRecord } from "./types.ts";

export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function readableTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1a1d27" : "#fff";
}

export interface TimeoutSpan {
  start: number;
  end: number;
}

function segmentNeedsGap(
  prevX: number,
  nextX: number,
  breakTimestamps: readonly number[],
): boolean {
  if (nextX - prevX > MAX_GAP_SEC) return true;
  for (const ts of breakTimestamps) {
    if (ts > prevX && ts < nextX) return true;
  }
  return false;
}

export function withGaps(points: ChartPoint[], breakTimestamps: readonly number[] = []): ChartPoint[] {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result: ChartPoint[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prevX = sorted[i - 1].x;
    const nextX = sorted[i].x;
    if (segmentNeedsGap(prevX, nextX, breakTimestamps)) {
      result.push({ x: prevX, y: null });
    }
    result.push(sorted[i]);
  }
  return result;
}

export function timeoutDurationSec(failure: DnsFailureRecord): number {
  if (failure.duration_ms && failure.duration_ms > 0) {
    return failure.duration_ms / 1000;
  }
  return monitorConfig.lookup_timeout_sec;
}

export function timeoutRanges(failures: DnsRecord[]): TimeoutSpan[] {
  const buckets = new Map<string, TimeoutSpan>();
  for (const f of failures) {
    if (!("error" in f) || !f.error || !isTimeoutError(f.error)) continue;
    const key = `${f.dns_server}\0${f.ts}`;
    const durationSec = timeoutDurationSec(f as DnsFailureRecord);
    const existing = buckets.get(key);
    if (!existing || durationSec > existing.end - existing.start) {
      buckets.set(key, { start: f.ts, end: f.ts + durationSec });
    }
  }
  return [...buckets.values()];
}