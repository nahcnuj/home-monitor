import type { AggregatedSuccess, DnsFailureRecord, DnsRecord, DnsSuccessRecord, TimeBounds } from "../types.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

export function collectTimestamps(records: DnsRecord[], xBounds: TimeBounds): number[] {
  const ts = new Set<number>();
  for (const r of records) {
    if (r.ts >= xBounds.min && r.ts <= xBounds.max) ts.add(r.ts);
  }
  return [...ts].sort((a, b) => a - b);
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

export function violinDataAt(
  rawRecords: DnsRecord[],
  server: string,
  ts: number,
  skipTs: Set<number>,
): number[] | null {
  if (skipTs.has(ts)) return null;
  const values = latencyValuesAt(rawRecords, server, ts);
  return values.length >= 2 ? values : null;
}

export function averageAt(
  successes: AggregatedSuccess[],
  server: string,
  ts: number,
  skipTs: Set<number>,
): number | null {
  if (skipTs.has(ts)) return null;
  const row = successes.find((s) => s.dns_server === server && s.ts === ts);
  return row ? row.latency_ms : null;
}

export function failurePointsAt(
  failures: DnsFailureRecord[],
  timestamps: number[],
): Array<{ x: number; y: number; error: string; dns_server: string; domain: string | null }> {
  const tsIndex = new Map(timestamps.map((ts, index) => [ts, index]));
  return failures.flatMap((f) => {
    const index = tsIndex.get(f.ts);
    if (index === undefined) return [];
    return [{
      x: index,
      y: 0,
      error: f.error,
      dns_server: f.dns_server,
      domain: f.domain,
    }];
  });
}