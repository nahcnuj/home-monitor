import { describe, expect, it } from "vitest";
import { withGaps } from "./utils.ts";

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
});