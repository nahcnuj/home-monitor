import { describe, expect, it } from "vitest";
import { DAY_SEC, HOUR_SEC, MIN_SEC } from "../constants.ts";
import { parseTsv } from "../data.ts";
import { setDisplayRangeSec } from "../state.ts";
import { buildRollingEnvelope, envelopeWindowSec } from "./rolling-envelope.ts";

describe("envelopeWindowSec", () => {
  it("uses same-second samples below 6h and wider windows above", () => {
    expect(envelopeWindowSec(3 * HOUR_SEC)).toBe(0);
    expect(envelopeWindowSec(6 * HOUR_SEC)).toBe(10 * MIN_SEC);
    expect(envelopeWindowSec(12 * HOUR_SEC)).toBe(HOUR_SEC);
    expect(envelopeWindowSec(24 * HOUR_SEC)).toBe(HOUR_SEC);
    expect(envelopeWindowSec(7 * DAY_SEC)).toBe(DAY_SEC);
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
    const q3 = envelope.q3.find((point) => point.x === ts);

    expect(max?.y).toBe(290);
    expect(q3?.y).toBeLessThan(290);
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