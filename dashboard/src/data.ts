import { DNS_ERROR_CODES } from "./errors.ts";
import { getDisplayCutoff } from "./time.ts";
import type {
  AggregatedSuccess,
  DnsFailureRecord,
  DnsRecord,
  DnsSuccessRecord,
  Stats,
} from "./types.ts";

function isSuccess(r: DnsRecord): r is DnsSuccessRecord {
  return !r.error;
}

function isDomainColumn(value: string | undefined): value is string {
  return typeof value === "string" && /[a-zA-Z]/.test(value) && !DNS_ERROR_CODES.has(value);
}

function isErrorToken(value: string | undefined): value is string {
  return typeof value === "string" && DNS_ERROR_CODES.has(value);
}

export function parseTsv(text: string): DnsRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  return trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line): DnsRecord => {
      const cols = line.split("\t");
      const ts = parseInt(cols[0] ?? "0", 10);
      const dns_server = cols[1] ?? "unknown";

      if (isDomainColumn(cols[2])) {
        const domain = cols[2];
        if (cols[4] || isErrorToken(cols[3])) {
          const duration_ms = cols[3] && !isErrorToken(cols[3]) ? Number(cols[3]) : undefined;
          return {
            ts,
            dns_server,
            domain,
            error: cols[4] || cols[3]!,
            duration_ms: Number.isFinite(duration_ms) ? duration_ms : undefined,
          };
        }
        const latency_ms = Number(cols[3]);
        if (!Number.isFinite(latency_ms)) {
          throw new Error(`Invalid latency at ts=${ts}: ${cols[3] ?? ""}`);
        }
        return { ts, dns_server, domain, latency_ms };
      }
      if (cols.length >= 4 && isErrorToken(cols[3])) {
        const duration_ms = cols[2] && !isErrorToken(cols[2]) ? Number(cols[2]) : undefined;
        return {
          ts,
          dns_server,
          domain: null,
          error: cols[3],
          duration_ms: Number.isFinite(duration_ms) ? duration_ms : undefined,
        };
      }
      if (isErrorToken(cols[2])) {
        return { ts, dns_server, domain: null, error: cols[2] };
      }
      const latency_ms = Number(cols[2]);
      if (!Number.isFinite(latency_ms)) {
        throw new Error(`Invalid latency at ts=${ts}: ${cols[3] ?? cols[2] ?? ""}`);
      }
      return { ts, dns_server, domain: null, latency_ms };
    });
}

/** Load records from Actions-generated JSON (DnsRecord[]). */
export function parseRecordsJson(text: string): DnsRecord[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error("dns-latency.json must be a JSON array");
  }
  return data as DnsRecord[];
}

export function aggregateByServer(records: DnsRecord[]): {
  successes: AggregatedSuccess[];
  failures: DnsFailureRecord[];
} {
  const successBuckets = new Map<string, { dns_server: string; ts: number; sum: number; count: number }>();
  const failureBuckets = new Map<string, DnsFailureRecord>();

  for (const r of records) {
    const key = `${r.dns_server}\0${r.ts}`;
    if (!isSuccess(r)) {
      if (!failureBuckets.has(key)) failureBuckets.set(key, r);
      continue;
    }
    if (!successBuckets.has(key)) {
      successBuckets.set(key, { dns_server: r.dns_server, ts: r.ts, sum: 0, count: 0 });
    }
    const bucket = successBuckets.get(key)!;
    bucket.sum += r.latency_ms;
    bucket.count += 1;
  }

  const successes = [...successBuckets.values()].map((bucket) => ({
    dns_server: bucket.dns_server,
    ts: bucket.ts,
    latency_ms: bucket.sum / bucket.count,
  }));
  const failures = [...failureBuckets.values()];

  return { successes, failures };
}

export function filterByPeriod(records: DnsRecord[], dataCutoffTs: number): DnsRecord[] {
  const cutoff = getDisplayCutoff(dataCutoffTs);
  return records.filter((r) => r.ts >= cutoff);
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Ceil a value (e.g. p95*2) up to the next multiple of 100 (for y-axis max in ms).
 * "100ms単位で切り上げ"
 */
export function ceilingToHundred(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 100) * 100;
}

export function computeStats(records: DnsRecord[]): Stats {
  const successes = records.filter(isSuccess);
  const failures = records.filter((r): r is DnsFailureRecord => Boolean(r.error));
  const latencies = successes.map((r) => r.latency_ms);
  const total = records.length;
  return {
    total,
    uptime: total ? (successes.length / total) * 100 : 0,
    avg: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p95: percentile(latencies, 95),
    max: latencies.length ? Math.max(...latencies) : 0,
    errors: failures.reduce<Record<string, number>>((acc, r) => {
      acc[r.error] = (acc[r.error] || 0) + 1;
      return acc;
    }, {}),
  };
}