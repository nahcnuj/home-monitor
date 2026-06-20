import { boxplot } from "@sgratzl/boxplots";
import { MEASURE_INTERVAL_SEC } from "../constants.ts";
import type { DnsRecord, DnsSuccessRecord, ViolinTimeSeries } from "../types.ts";
import { withAlpha } from "../utils.ts";

const VIOLIN_POINTS = 100;

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

function computeSamples(min: number, max: number, points: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const samples: number[] = [];
  const inc = range / points;
  for (let v = min; v <= max; v += inc) samples.push(v);
  if (samples.at(-1) !== max) samples.push(max);
  return samples;
}

function spansCoverTs(spans: { start: number; end: number }[], ts: number): boolean {
  return spans.some((span) => ts >= span.start && ts < span.end);
}

export function buildViolinSeries(
  rawRecords: DnsRecord[],
  servers: string[],
  colors: readonly string[],
  skipSpansByServer: Map<string, { start: number; end: number }[]>,
): ViolinTimeSeries[] {
  const offsetStep = MEASURE_INTERVAL_SEC * 0.12;

  return servers.map((server, index) => {
    const buckets = new Map<number, number[]>();
    for (const r of rawRecords.filter(isSuccess)) {
      if (r.dns_server !== server) continue;
      if (!buckets.has(r.ts)) buckets.set(r.ts, []);
      buckets.get(r.ts)!.push(r.latency_ms);
    }

    return {
      dns_server: server,
      color: colors[index % colors.length],
      xOffsetSec: (index - (servers.length - 1) / 2) * offsetStep,
      skipSpans: skipSpansByServer.get(server) ?? [],
      buckets: [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, values]) => ({ ts, values })),
    };
  });
}

function drawViolinAt(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  values: number[],
  yToPixel: (y: number) => number,
  halfWidthPx: number,
  color: string,
): void {
  const stats = boxplot(values);
  const samples = computeSamples(stats.min, stats.max, VIOLIN_POINTS);
  const coords = samples.map((v) => ({ v, estimate: stats.kde(v) }));
  const maxEstimate = Math.max(...coords.map((c) => c.estimate), 1e-9);
  const factor = halfWidthPx / maxEstimate;

  ctx.beginPath();
  for (const c of coords) ctx.lineTo(centerX + c.estimate * factor, yToPixel(c.v));
  for (const c of [...coords].reverse()) ctx.lineTo(centerX - c.estimate * factor, yToPixel(c.v));
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.32);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.75);
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function drawViolinSeries(
  ctx: CanvasRenderingContext2D,
  series: ViolinTimeSeries[],
  xToPixel: (ts: number) => number,
  yToPixel: (y: number) => number,
  halfWidthAt: (ts: number) => number,
  chartLeft: number,
  chartRight: number,
): void {
  for (const { color, xOffsetSec, skipSpans, buckets } of series) {
    for (const { ts, values } of buckets) {
      if (values.length < 2 || spansCoverTs(skipSpans, ts)) continue;

      const centerX = xToPixel(ts + xOffsetSec);
      if (centerX < chartLeft - 20 || centerX > chartRight + 20) continue;

      drawViolinAt(ctx, centerX, values, yToPixel, halfWidthAt(ts + xOffsetSec), color);
    }
  }
}