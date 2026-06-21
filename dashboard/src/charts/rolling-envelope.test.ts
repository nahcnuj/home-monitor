import { describe, expect, it } from "vitest";
import { parseTsv } from "../data.ts";
import { buildRollingEnvelope } from "./rolling-envelope.ts";

describe("buildRollingEnvelope", () => {
  it("sets band max to the batch maximum when one domain spikes", () => {
    const ts = 1782008823;
    const records = parseTsv([
      `${ts}\t203.165.31.152\tamazon.co.jp\t167`,
      `${ts}\t203.165.31.152\tapple.com\t228`,
      `${ts}\t203.165.31.152\tcloudflare.com\t232`,
      `${ts}\t203.165.31.152\tline.me\t290`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts], []);
    const max = envelope.max.find((point) => point.x === ts);
    const q3 = envelope.q3.find((point) => point.x === ts);

    expect(max?.y).toBe(290);
    expect(q3?.y).toBeLessThan(290);
  });

  it("uses only samples from the same measurement timestamp", () => {
    const ts = 1000;
    const records = parseTsv([
      `${ts}\t203.165.31.152\ta.com\t200`,
      `${ts}\t203.165.31.152\tb.com\t210`,
      `${ts + 60}\t203.165.31.152\tc.com\t500`,
      `${ts + 60}\t203.165.31.152\td.com\t520`,
    ].join("\n"));

    const envelope = buildRollingEnvelope(records, "203.165.31.152", [ts], []);
    const max = envelope.max.find((point) => point.x === ts);

    expect(max?.y).toBe(210);
  });
});