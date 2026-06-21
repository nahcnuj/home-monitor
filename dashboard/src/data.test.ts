import { describe, expect, it } from "vitest";
import { aggregateByServer, computeStats, filterByPeriod, parseTsv } from "./data.ts";
import { sampleTsv } from "./test/fixtures.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "./state.ts";

describe("parseTsv", () => {
  it("parses published dns-latency.tsv without NaN latencies", () => {
    const records = parseTsv(sampleTsv);
    expect(records.length).toBeGreaterThan(0);

    for (const record of records) {
      if (!record.error) {
        expect(Number.isFinite(record.latency_ms)).toBe(true);
      }
    }
  });

  it("parses 3-column legacy timeout rows", () => {
    const records = parseTsv("1781961002\t203.165.31.152\ttimeout");
    expect(records).toEqual([
      { ts: 1781961002, dns_server: "203.165.31.152", domain: null, error: "timeout" },
    ]);
  });

  it("parses legacy and per-domain rows", () => {
    const records = parseTsv([
      "1781960628\t203.165.31.152\t324",
      "1781962922\t203.165.31.152\tgoogle.com\t301",
      "1781961002\t203.165.31.152\t\ttimeout",
      "1781962802\t203.165.31.152\tcloudflare.com\t60012\ttimeout",
    ].join("\n"));

    expect(records).toMatchObject([
      { latency_ms: 324, domain: null },
      { latency_ms: 301, domain: "google.com" },
      { error: "timeout", domain: null },
      { error: "timeout", domain: "cloudflare.com", duration_ms: 60012 },
    ]);
  });
});

describe("computeStats", () => {
  it("reports uptime as the success share of measurements", () => {
    const records = parseTsv([
      "1000\t203.165.31.152\tgoogle.com\t100",
      "1000\t203.165.31.152\tline.me\t\ttimeout",
      "1060\t203.165.31.152\tyahoo.co.jp\t120",
    ].join("\n"));

    expect(computeStats(records).uptime).toBeCloseTo(66.7, 1);
  });
});

describe("dashboard pipeline", () => {
  it("aggregates and filters published data", () => {
    setDisplayRangeSec(24 * 3600);
    setDataCutoffTs(1781967600);

    const records = parseTsv(sampleTsv);
    const filtered = filterByPeriod(records, 1781967600);
    expect(filtered.length).toBeGreaterThan(0);

    const { successes, failures } = aggregateByServer(filtered);
    expect(successes.length).toBeGreaterThan(0);
    expect(successes.every((s) => Number.isFinite(s.latency_ms))).toBe(true);

    const stats = computeStats(filtered);
    expect(stats.total).toBeGreaterThan(0);
    expect(Number.isFinite(stats.avg)).toBe(true);
    expect(stats.uptime).toBeGreaterThan(0);
    expect(stats.uptime).toBeLessThanOrEqual(100);
    expect(failures.length).toBeGreaterThan(0);
  });
});