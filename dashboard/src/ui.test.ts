import { describe, expect, it, beforeEach } from "vitest";
import { renderStats, uptimeColorClass } from "./ui.ts";
import type { Stats } from "./types.ts";

function makeStats(uptime: number, total = 10): Stats {
  return { total, uptime, avg: 10, p95: 20, max: 30, errors: {} };
}

describe("uptimeColorClass", () => {
  it("returns green at >= 99.95", () => {
    expect(uptimeColorClass(99.95)).toBe("green");
    expect(uptimeColorClass(100)).toBe("green");
  });

  it("returns orange at >= 99.90 and < 99.95", () => {
    expect(uptimeColorClass(99.9)).toBe("orange");
    expect(uptimeColorClass(99.94)).toBe("orange");
  });

  it("returns yellow at >= 99.00 and < 99.90", () => {
    expect(uptimeColorClass(99.0)).toBe("yellow");
    expect(uptimeColorClass(99.89)).toBe("yellow");
  });

  it("returns red otherwise", () => {
    expect(uptimeColorClass(98.99)).toBe("red");
    expect(uptimeColorClass(0)).toBe("red");
  });
});

describe("renderStats uptime badge", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<p class="uptime-badge" id="uptimeBadge" aria-label="Uptime"></p><div id="statsGrid"></div>';
  });

  it("applies the color class for a given uptime", () => {
    renderStats(makeStats(99.9));
    const badge = document.getElementById("uptimeBadge")!;
    expect(badge.classList.contains("orange")).toBe(true);
    expect(badge.innerHTML).toContain("99.9%");
  });

  it("removes stale color classes", () => {
    const badge = document.getElementById("uptimeBadge")!;
    badge.classList.add("red", "orange");
    renderStats(makeStats(99.0));
    expect(badge.classList.contains("red")).toBe(false);
    expect(badge.classList.contains("orange")).toBe(false);
    expect(badge.classList.contains("yellow")).toBe(true);
  });

  it("shows dash and no color class when there are no measurements", () => {
    renderStats(makeStats(0, 0));
    const badge = document.getElementById("uptimeBadge")!;
    expect(badge.innerHTML).toContain("—");
    expect(badge.classList.contains("green")).toBe(false);
    expect(badge.classList.contains("red")).toBe(false);
  });
});