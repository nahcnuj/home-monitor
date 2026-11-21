import { describe, expect, it } from "vitest";
import { formatAnnotation } from "../report-downdetector.mjs";

describe("formatAnnotation #133 unchanged count", () => {
  it("does not annotate an unchanged count as a success", () => {
    const out = formatAnnotation({
      beforeCount: 73,
      afterCount: 73,
      count: 1,
      category: "Broadband Internet",
      problemType: "timeout",
      accepted: true,
      success: true,
      reportPostStatus: 200,
    });
    expect(out).not.toContain("reported (success)");
    expect(out).toContain("report count before: 73 → after: 73");
  });

  it("still annotates a changed count as a success", () => {
    const out = formatAnnotation({
      beforeCount: 73,
      afterCount: 74,
      count: 1,
      category: "Broadband Internet",
      success: true,
    });
    expect(out).toContain("reported (success)");
  });

  it("annotates a failed unchanged report as not reported", () => {
    const out = formatAnnotation({
      beforeCount: 73,
      afterCount: 73,
      count: 1,
      category: "Broadband Internet",
      success: false,
    });
    expect(out).toContain("not reported (failed)");
  });
});