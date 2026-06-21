import { describe, expect, it } from "vitest";
import { errorTooltipAnchor } from "./error.ts";

describe("errorTooltipAnchor", () => {
  it("anchors the tooltip below the hovered bar segment", () => {
    expect(errorTooltipAnchor({ x: 180, base: 60 }, 100)).toEqual({
      x: 120,
      y: 108,
    });
  });
});