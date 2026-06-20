import { MAX_GAP_SEC, MEASURE_INTERVAL_SEC } from "./constants.ts";
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

function segmentCrossesTimeout(prevX: number, nextX: number, spans: TimeoutSpan[]): boolean {
  for (const { start, end } of spans) {
    if (start < nextX && end > prevX) return true;
  }
  return false;
}

export function withGaps(points: ChartPoint[], spans: TimeoutSpan[] = []): ChartPoint[] {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result: ChartPoint[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prevX = sorted[i - 1].x;
    const nextX = sorted[i].x;
    if (nextX - prevX > MAX_GAP_SEC || segmentCrossesTimeout(prevX, nextX, spans)) {
      result.push({ x: prevX, y: null });
    }
    result.push(sorted[i]);
  }
  return result;
}

function timeoutDurationSec(failure: DnsFailureRecord): number {
  if (failure.duration_ms && failure.duration_ms > 0) {
    return failure.duration_ms / 1000;
  }
  return MEASURE_INTERVAL_SEC;
}

export function timeoutSpansForServer(failures: DnsFailureRecord[], server: string): TimeoutSpan[] {
  const buckets = new Map<number, number>();
  for (const f of failures) {
    if (f.dns_server !== server || f.error !== "timeout") continue;
    const durationSec = timeoutDurationSec(f);
    buckets.set(f.ts, Math.max(buckets.get(f.ts) ?? 0, durationSec));
  }
  return [...buckets.entries()].map(([start, durationSec]) => ({
    start,
    end: start + durationSec,
  }));
}

export function timeoutRanges(failures: DnsRecord[]): TimeoutSpan[] {
  const buckets = new Map<string, TimeoutSpan>();
  for (const f of failures) {
    if (!("error" in f) || f.error !== "timeout") continue;
    const key = `${f.dns_server}\0${f.ts}`;
    const durationSec = timeoutDurationSec(f as DnsFailureRecord);
    const existing = buckets.get(key);
    if (!existing || durationSec > existing.end - existing.start) {
      buckets.set(key, { start: f.ts, end: f.ts + durationSec });
    }
  }
  return [...buckets.values()];
}