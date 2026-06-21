import { describe, expect, it } from "vitest";
import { monitorConfig } from "./config.ts";
import { parseTsv } from "./data.ts";
import type { DnsFailureRecord } from "./types.ts";
import { timeoutDurationSec, timeoutRanges, withGaps } from "./utils.ts";

describe("withGaps", () => {
  it("does not insert gaps between nearby points", () => {
    const points = [
      { x: 100, y: 10 },
      { x: 160, y: 20 },
    ];
    expect(withGaps(points).some((point) => point.y === null)).toBe(false);
  });

  it("inserts a gap only after long measurement pauses", () => {
    const points = [
      { x: 100, y: 10 },
      { x: 400, y: 20 },
    ];
    const result = withGaps(points);
    expect(result).toEqual([
      { x: 100, y: 10 },
      { x: 100, y: null },
      { x: 400, y: 20 },
    ]);
  });

  it("uses measured duration for timeout shading when duration_ms is present", () => {
    const [failure] = parseTsv("1782000000\t203.165.31.152\tgoogle.com\t15000\tjob_timeout");
    expect(timeoutDurationSec(failure as DnsFailureRecord)).toBe(15);

    const ranges = timeoutRanges(parseTsv([
      "1782000000\t203.165.31.152\tgoogle.com\t15000\tjob_timeout",
      "1782000000\t203.165.31.152\tline.me\t8200\tdns_timeout",
    ].join("\n")));

    expect(ranges).toEqual([{ start: 1782000000, end: 1782000000 + 15 }]);
  });

  it("falls back to lookup_timeout_sec when timeout rows omit duration_ms", () => {
    const [failure] = parseTsv("1782000000\t203.165.31.152\tgoogle.com\t\ttimeout");
    expect(timeoutDurationSec(failure as DnsFailureRecord)).toBe(monitorConfig.lookup_timeout_sec);
  });

  it("inserts a gap when a zero-success timestamp sits between points", () => {
    const points = [
      { x: 100, y: 10 },
      { x: 160, y: 20 },
    ];
    const result = withGaps(points, [130]);
    expect(result).toEqual([
      { x: 100, y: 10 },
      { x: 100, y: null },
      { x: 160, y: 20 },
    ]);
  });
});