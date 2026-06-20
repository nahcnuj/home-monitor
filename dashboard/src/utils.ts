import { MAX_GAP_SEC, MEASURE_INTERVAL_SEC } from "./constants.ts";
import type { ChartPoint, DnsRecord, DnsSuccessRecord } from "./types.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

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

function segmentCrossesTimeout(prevX: number, nextX: number, timeoutTs: number[]): boolean {
  for (const t of timeoutTs) {
    if (t < nextX && t + MEASURE_INTERVAL_SEC > prevX) return true;
  }
  return false;
}

export function withGaps(points: ChartPoint[], timeoutTs: number[] = []): ChartPoint[] {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result: ChartPoint[] = [sorted[0]];
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

export function latencyRangePoints(
  rawRecords: DnsRecord[],
  server: string,
): { min: ChartPoint[]; max: ChartPoint[] } {
  const buckets = new Map<number, number[]>();

  for (const r of rawRecords.filter(isSuccess)) {
    if (r.dns_server !== server) continue;
    if (!buckets.has(r.ts)) buckets.set(r.ts, []);
    buckets.get(r.ts)!.push(r.latency_ms);
  }

  const min: ChartPoint[] = [];
  const max: ChartPoint[] = [];
  for (const [ts, values] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (values.length < 2) continue;
    min.push({ x: ts, y: Math.min(...values) });
    max.push({ x: ts, y: Math.max(...values) });
  }
  return { min, max };
}

export function timeoutRanges(failures: DnsRecord[]): { start: number; end: number }[] {
  const seen = new Set<number>();
  const ranges: { start: number; end: number }[] = [];
  for (const f of failures) {
    if (f.error !== "timeout" || seen.has(f.ts)) continue;
    seen.add(f.ts);
    ranges.push({ start: f.ts, end: f.ts + MEASURE_INTERVAL_SEC });
  }
  return ranges;
}