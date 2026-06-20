import type { DnsRecord, DnsSuccessRecord } from "../types.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
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