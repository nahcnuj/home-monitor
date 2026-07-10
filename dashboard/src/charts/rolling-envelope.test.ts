import { describe, expect, it } from "vitest";
import { DAY_SEC, HOUR_SEC, MIN_SEC } from "../constants.ts";
import { parseTsv } from "../data.ts";
import { setDisplayRangeSec } from "../state.ts";
import {
  buildRollingEnvelope,
  collectTimelineTimestamps,
  envelopeWindowSec,
  lowerBound,
  upperBound,
  windowMoments,
} from "./rolling-envelope.ts";

describe("lowerBound / upperBound / windowMoments", () => {
  it("binary-searches sorted timestamps", () => {
    const sorted = [10, 20, 20, 30, 40];
    expect(lowerBound(sorted, 20)).toBe(1);
    expect(upperBound(sorted, 20)).toBe(3);
    expect(lowerBound(sorted, 25)).toBe(3);
    expect(upperBound(sorted, 40)).toBe(5);
  });

  it("computes min max mean std over a slice", () => {
    const values = [10, 20, 30, 40];
    const m = windowMoments(values, 1, 4)!;
    expect(m.min).toBe(20);
    expect(m.max).toBe(40);
    expect(m.mean).toBe(30);
    expect(m.count).toBe(3);
  });
});

describe("envelopeWindowSec", () => {
  it("uses same-second samples below 6h and wider windows above", () => {
    expect(envelopeWindowSec(3 * HOUR_SEC)).toBe(0);
    expect(envelopeWindowSec(6 * HOUR_SEC)).toBe(10 * MIN_SEC);
    expect(envelopeWindowSec(12 * HOUR_SEC)).toBe(HOUR_SEC);
    expect(envelopeWindowSec(24 * HOUR_SEC)).toBe(HOUR_SEC);
    expect(envelopeWindowSec(7 * DAY_SEC)).toBe(DAY_SEC);
  });
});

describe("collectTimelineTimestamps", () => {
  it("returns step 1 and all timestamps if count is <= 400", () => {
    const records = [
      { ts: 100, dns_server: "a", latency_ms: 10 },
      { ts: 200, dns_server: "a", latency_ms: 20 },
    ] as any;
    const result = collectTimelineTimestamps(records, 0, 1000);
    expect(result.step).toBe(1);
    expect(result.timestamps).toEqual([100, 200]);
  });

  it("downsamples only when density would exceed the viewport-based budget", () => {
    // 800 minutes of data, 1h viewport → budget ≈ 240 * (800/60) ≈ 3200, capped later;
    // with span≈800min and default 240/viewport, small spans keep more detail.
    const records = Array.from({ length: 800 }, (_, i) => ({
      ts: i * 60,
      dns_server: "a",
      latency_ms: 10,
    })) as any;
    const oneHour = 3600;
    const result = collectTimelineTimestamps(records, 0, 800 * 60, oneHour, 240);
    // 800 points fit under the short-zoom hard cap → keep all
    expect(result.step).toBe(1);
    expect(result.timestamps.length).toBe(800);
  });

  it("keeps roughly pointsPerViewport samples inside one viewport of a long span", () => {
    // 7 days of 1-minute samples
    const n = 7 * 24 * 60;
    const records = Array.from({ length: n }, (_, i) => ({
      ts: i * 60,
      dns_server: "a",
      latency_ms: 10,
    })) as any;
    const spanMax = n * 60;
    const viewport = 6 * 3600;
    const result = collectTimelineTimestamps(records, 0, spanMax, viewport, 240);
    // 6h zoom uses the long-range hard cap (5k)
    expect(result.timestamps.length).toBeLessThanOrEqual(5000);
    // Density in a 6h window should stay on the order of pointsPerViewport, not ~400/28.
    const inView = result.timestamps.filter((t) => t >= spanMax - viewport).length;
    expect(inView).toBeGreaterThan(100);
  });

  it("keeps near-full minute density for short zooms over a week of history", () => {
    const n = 7 * 24 * 60;
    const records = Array.from({ length: n }, (_, i) => ({
      ts: i * 60,
      dns_server: "a",
      latency_ms: 10,
    })) as any;
    const spanMax = n * 60;
    const viewport = 30 * 60;
    const result = collectTimelineTimestamps(records, 0, spanMax, viewport, 240);
    expect(result.step).toBe(1);
    expect(result.timestamps.length).toBe(n);
  });
});

describe("buildRollingEnvelope", () => {
  it("sets band max to the batch maximum when one domain spikes", () => {
    setDisplayRangeSec(HOUR_SEC);
    const ts = 1782008823;
    const records = parseTsv([
      `${ts}\t203.165.31.152\tamazon.co.jp\t167`,
      `${ts}\t203.165.31.152\tapple.com\t228`,
      `${ts}\t203.165.31.152\tcloudflare.com\t232`,
      `${ts}\t203.165.31.152\tline.me\t290`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts]);
    const max = envelope.max.find((point) => point.x === ts);
    const meanHigh = envelope.meanHigh.find((point) => point.x === ts);

    expect(max?.y).toBe(290);
    expect(meanHigh?.y).toBeLessThan(290);
  });

  it("uses only samples from the same measurement timestamp below 6h", () => {
    setDisplayRangeSec(HOUR_SEC);
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts}\t203.165.31.152\tb.com\t210`,
      `${ts + 60}\t203.165.31.152\tc.com\t500`,
      `${ts + 60}\t203.165.31.152\td.com\t520`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts]);
    const max = envelope.max.find((point) => point.x === ts);

    expect(max?.y).toBe(210);
  });

  it("aggregates a 10-minute window on the 6h range", () => {
    setDisplayRangeSec(6 * HOUR_SEC);
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts}\t203.165.31.152\tb.com\t210`,
      `${ts + 5 * 60}\t203.165.31.152\tc.com\t500`,
      `${ts + 5 * 60}\t203.165.31.152\td.com\t520`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts + 5 * 60]);
    const max = envelope.max.find((point) => point.x === ts + 5 * 60);

    expect(max?.y).toBe(520);
  });

  it("keeps band points when some domains time out in the same batch", () => {
    setDisplayRangeSec(HOUR_SEC);
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts}\t203.165.31.152\tb.com\t210`,
      `${ts}\t203.165.31.152\tc.com\t\ttimeout`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts]);
    expect(envelope.max.find((point) => point.x === ts)?.y).toBe(210);
  });

  it("keeps band points at timeout timestamps when the window has enough successes", () => {
    setDisplayRangeSec(6 * HOUR_SEC);
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts}\t203.165.31.152\tb.com\t210`,
      `${ts}\t203.165.31.152\tfail.com\t\ttimeout`,
      `${ts + 5 * 60}\t203.165.31.152\tc.com\t500`,
      `${ts + 5 * 60}\t203.165.31.152\td.com\t520`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts]);
    expect(envelope.max.find((point) => point.x === ts)?.y).toBe(520);
  });

  it("marks timestamps with zero successes for band gaps", () => {
    setDisplayRangeSec(HOUR_SEC);
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts + 60}\t203.165.31.152\tb.com\t\ttimeout`,
      `${ts + 60}\t203.165.31.152\tc.com\t\ttimeout`,
      `${ts + 120}\t203.165.31.152\td.com\t220`,
      `${ts + 120}\t203.165.31.152\te.com\t230`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(
      records,
      "203.165.31.152",
      [ts, ts + 60, ts + 120],
    );

    expect(envelope.emptyTimestamps).toEqual([ts + 60]);
    expect(envelope.max.some((point) => point.x === ts + 60)).toBe(false);
  });
});