import type { DnsRecord } from "../types.ts";

/** Synthetic multi-day DNS samples for render benchmarks (deterministic). */
export function generateBenchRecords(options: {
  days?: number;
  intervalSec?: number;
  servers?: string[];
  domains?: string[];
  startTs?: number;
}): DnsRecord[] {
  const days = options.days ?? 7;
  const intervalSec = options.intervalSec ?? 60;
  const servers = options.servers ?? ["203.165.31.152", "122.197.254.136"];
  const domains = options.domains ?? [
    "google.com",
    "cloudflare.com",
    "github.com",
    "amazon.co.jp",
    "apple.com",
    "line.me",
    "microsoft.com",
    "yahoo.co.jp",
  ];
  const startTs = options.startTs ?? 1_780_000_000;
  const endTs = startTs + days * 24 * 3600;
  const records: DnsRecord[] = [];

  for (let ts = startTs; ts < endTs; ts += intervalSec) {
    for (const dns_server of servers) {
      for (let d = 0; d < domains.length; d++) {
        // Pseudo-random but deterministic latency (and rare failures).
        const seed = (ts * 31 + dns_server.length * 17 + d * 13) >>> 0;
        const fail = seed % 200 === 0;
        if (fail) {
          records.push({
            ts,
            dns_server,
            domain: domains[d],
            error: seed % 400 === 0 ? "dns_timeout" : "no_response",
            duration_ms: 1000 + (seed % 5000),
          });
        } else {
          const base = 40 + (dns_server.charCodeAt(0) % 30);
          const wave = Math.sin(ts / 3600) * 20;
          const spike = seed % 97 === 0 ? 400 + (seed % 800) : 0;
          records.push({
            ts,
            dns_server,
            domain: domains[d],
            latency_ms: Math.max(5, Math.round(base + wave + (seed % 40) + spike)),
          });
        }
      }
    }
  }
  return records;
}
