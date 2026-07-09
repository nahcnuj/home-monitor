import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateByServer,
  ceilingToHundred,
  computeStats,
  filterByPeriod,
  parseRecordsJson,
  parseTsv,
  percentile,
} from "./data.ts";
import { setDataCutoffTs, setDisplayRangeSec } from "./state.ts";
import { sampleTsv } from "./test/fixtures.ts";

describe("parseTsv", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date(2026, 5, 21, 15, 0, 0),
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

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

  it("returns empty array for blank TSV", () => {
    expect(parseTsv("")).toEqual([]);
    expect(parseTsv("\n")).toEqual([]);
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

describe("parseRecordsJson", () => {
  it("loads DnsRecord arrays produced for the dashboard", () => {
    const tsv = [
      "1781962922\t203.165.31.152\tgoogle.com\t301",
      "1781962802\t203.165.31.152\tcloudflare.com\t60012\ttimeout",
    ].join("\n");
    const fromTsv = parseTsv(tsv);
    const fromJson = parseRecordsJson(JSON.stringify(fromTsv));
    expect(fromJson).toEqual(fromTsv);
  });

  it("rejects non-arrays", () => {
    expect(() => parseRecordsJson("{}")).toThrow(/array/i);
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

  it("computes p95 and max", () => {
    const records = parseTsv([
      "1000\t203.165.31.152\td1\t10",
      "1000\t203.165.31.152\td1\t20",
      "1000\t203.165.31.152\td1\t30",
      "1000\t203.165.31.152\td1\t40",
      "1000\t203.165.31.152\td1\t1000", // outlier
    ].join("\n"));

    const stats = computeStats(records);
    // n=5 → ceil(0.95*5)-1 = 4 → picks the largest (this impl's p95 for small n)
    expect(stats.p95).toBe(1000);
    expect(stats.max).toBe(1000);
  });
});

describe("percentile", () => {
  it("returns 0 for empty input", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("picks the appropriate order statistic for p95", () => {
    // n=5: ceil(4.75)-1 = 4 → last element for p95 with this impl
    expect(percentile([10, 20, 30, 40, 1000], 95)).toBe(1000);
    // n=21 case similar to chart test: mostly low + outlier → p95 from lows
    const lows = Array.from({ length: 20 }, (_, i) => 100 + i);
    const vals = [...lows, 5000];
    expect(percentile(vals, 95)).toBe(lows[19]); // index 19
  });
});

describe("ceilingToHundred", () => {
  it("returns 0 for non-positive or non-finite values", () => {
    expect(ceilingToHundred(0)).toBe(0);
    expect(ceilingToHundred(-10)).toBe(0);
    expect(ceilingToHundred(NaN)).toBe(0);
    expect(ceilingToHundred(Infinity)).toBe(0);
  });

  it("ceil to next 100ms unit", () => {
    expect(ceilingToHundred(1)).toBe(100);
    expect(ceilingToHundred(99)).toBe(100);
    expect(ceilingToHundred(100)).toBe(100);
    expect(ceilingToHundred(101)).toBe(200);
    expect(ceilingToHundred(123.7)).toBe(200);
    expect(ceilingToHundred(200)).toBe(200);
    expect(ceilingToHundred(999)).toBe(1000);
    expect(ceilingToHundred(1000)).toBe(1000);
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
