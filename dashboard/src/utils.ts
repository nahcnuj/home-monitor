import { MAX_GAP_SEC, MEASURE_INTERVAL_SEC } from "./constants.ts";
import type { ChartPoint, DnsRecord } from "./types.ts";

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