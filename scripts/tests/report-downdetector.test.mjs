import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOptions,
  determineSuccess,
  escapeRegExp,
  extractAvailableCategories,
  extractReportCount,
  getReportCount,
  hasReportCountIncreased,
  isCloudflareChallenge,
  isRateLimited,
  labelCandidates,
  markReported,
  parseArgs,
} from "../report-downdetector.mjs";

describe("labelCandidates", () => {
  it("returns a single label as one candidate", () => {
    expect(labelCandidates("ブロードバンド")).toEqual(["ブロードバンド"]);
  });

  it("splits a comma-separated list and trims each entry", () => {
    expect(labelCandidates("ブロードバンド, Broadband Internet")).toEqual([
      "ブロードバンド",
      "Broadband Internet",
    ]);
  });

  it("drops empty entries", () => {
    expect(labelCandidates("a, ,b")).toEqual(["a", "b"]);
  });
});

describe("parseArgs", () => {
  it("parses --key value pairs", () => {
    expect(
      parseArgs(["--page-url", "https://downdetector.jp/shougai/jcom/"]),
    ).toEqual({ "page-url": "https://downdetector.jp/shougai/jcom/" });
  });

  it("treats a flag without a value as true", () => {
    expect(parseArgs(["--headless"])).toEqual({ headless: "true" });
  });

  it("does not consume the next flag as a value", () => {
    expect(parseArgs(["--count", "--state-file", "/tmp/state"])).toEqual({
      count: "true",
      "state-file": "/tmp/state",
    });
  });

  it("ignores non-flag arguments", () => {
    expect(parseArgs(["report-downdetector.mjs", "--count", "3"])).toEqual({
      count: "3",
    });
  });

  it("supports --key=value pairs", () => {
    expect(parseArgs(["--headless=false", "--count=5"])).toEqual({
      headless: "false",
      count: "5",
    });
    expect(parseArgs(["--indicator=ブロードバンド"])).toEqual({
      indicator: "ブロードバンド",
    });
  });
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
    expect(escapeRegExp("J:COM (Fixed)")).toBe("J:COM \\(Fixed\\)");
  });

  it("produces a regex that matches the literal label", () => {
    const label = "Broadband Internet (v2)";
    const re = new RegExp(escapeRegExp(label), "i");
    expect(re.test("broadband internet (v2)")).toBe(true);
    expect(re.test("Broadband Internet v2")).toBe(false);
  });
});

describe("buildOptions", () => {
  it("prefers CLI flags over env and defaults", () => {
    const options = buildOptions(
      ["--page-url", "https://example.jp/", "--count", "7"],
      { DD_INDICATOR: "Env Indicator", DD_PAGE_URL: "https://env.example/" },
    );
    expect(options.pageUrl).toBe("https://example.jp/");
    expect(options.count).toBe(7);
    expect(options.indicatorLabel).toBe("Env Indicator");
  });

  it("falls back to env vars", () => {
    const options = buildOptions([], {
      DD_PAGE_URL: "https://env.example/",
      DD_INDICATOR: "Env Indicator",
      DD_STATE_FILE: "/tmp/state",
      DD_RATE_LIMIT_SEC: "60",
    });
    expect(options.pageUrl).toBe("https://env.example/");
    expect(options.indicatorLabel).toBe("Env Indicator");
    expect(options.stateFile).toBe("/tmp/state");
    expect(options.rateLimitSec).toBe(60);
  });

  it("applies defaults", () => {
    const options = buildOptions([], {});
    expect(options.indicatorLabel).toBe("ブロードバンド");
    expect(options.headless).toBe(false);
    expect(options.timeoutMs).toBe(90000);
    expect(options.problemType).toBe("timeout");
    expect(options.count).toBe(1);
    expect(options.rateLimitSec).toBe(1800);
    expect(options.stateFile).toContain(".downdetector-state/last-report");
    expect(options.waitUntil).toBe("domcontentloaded");
    expect(options.maxRetries).toBe(2);
    expect(options.channel).toBe("chrome");
  });

  it("disables headless when requested", () => {
    expect(buildOptions(["--headless", "false"], {}).headless).toBe(false);
    expect(buildOptions(["--headless"], {}).headless).toBe(true);
    expect(buildOptions([], { DD_HEADLESS: "0" }).headless).toBe(false);
    expect(buildOptions([], { DD_HEADLESS: "1" }).headless).toBe(true);
  });

  it("respects --channel and DD_CHANNEL", () => {
    expect(buildOptions(["--channel", "msedge"], {}).channel).toBe("msedge");
    expect(buildOptions([], { DD_CHANNEL: "chromium" }).channel).toBe("chromium");
    expect(buildOptions(["--channel", "chrome"], { DD_CHANNEL: "chromium" }).channel).toBe("chrome");
    // Empty string explicitly requests the bundled Chromium.
    expect(buildOptions(["--channel", ""], {}).channel).toBe("");
  });
});

describe("rate limit state", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dd-state-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not rate limited without a state file", () => {
    expect(
      isRateLimited(join(dir, "missing"), { nowSec: 1000, rateLimitSec: 1800 }),
    ).toBe(false);
  });

  it("is rate limited when the last report is recent", () => {
    const stateFile = join(dir, "last-report");
    writeFileSync(stateFile, "900", "utf8");
    expect(isRateLimited(stateFile, { nowSec: 1000, rateLimitSec: 1800 })).toBe(true);
  });

  it("is not rate limited after the rate limit window", () => {
    const stateFile = join(dir, "last-report");
    writeFileSync(stateFile, "900", "utf8");
    expect(isRateLimited(stateFile, { nowSec: 2701, rateLimitSec: 1800 })).toBe(false);
  });

  it("ignores a corrupt state file", () => {
    const stateFile = join(dir, "last-report");
    writeFileSync(stateFile, "not-a-timestamp", "utf8");
    expect(isRateLimited(stateFile, { nowSec: 1000, rateLimitSec: 1800 })).toBe(false);
  });

  it("markReported writes the timestamp and creates parent dirs", () => {
    const stateFile = join(dir, "nested", "last-report");
    markReported(stateFile, { nowSec: 12345 });
    expect(readFileSync(stateFile, "utf8")).toBe("12345");
    expect(isRateLimited(stateFile, { nowSec: 12345, rateLimitSec: 1800 })).toBe(true);
  });
});

function fakePage({ indicators = [], dialog = false } = {}) {
  const locatorFor = (result) => ({
    isVisible: async () => {
      if (result instanceof Error) throw result;
      return Boolean(result);
    },
    click: async () => {},
    waitFor: async () => {},
    waitForTimeout: async () => {},
  });
  let indicatorIndex = 0;
  return {
    getByRole: (role) => {
      if (role === "dialog") return locatorFor(dialog);
      return locatorFor(indicators[indicatorIndex++]);
    },
    getByText: () => locatorFor(indicators[indicatorIndex++]),
  };
}

describe("isCloudflareChallenge", () => {
  it("detects Cloudflare challenge by title", () => {
    expect(isCloudflareChallenge("Just a moment...", "")).toBe(true);
    expect(isCloudflareChallenge("Checking your browser...", "")).toBe(true);
    expect(isCloudflareChallenge("しばらくお待ちください...", "")).toBe(true);
  });

  it("detects Cloudflare challenge by content", () => {
    expect(isCloudflareChallenge("OK", "cf-challenge")).toBe(true);
    expect(isCloudflareChallenge("OK", "cloudflare challenge")).toBe(true);
    expect(isCloudflareChallenge("OK", "Ray ID please wait")).toBe(true);
  });

  it("returns false for normal pages", () => {
    expect(isCloudflareChallenge("Jcom", "<html>hello</html>")).toBe(false);
  });
});

describe("extractAvailableCategories", () => {
  it("trims and filters empty strings", () => {
    expect(extractAvailableCategories([" A ", "", "B"])).toEqual(["A", "B"]);
  });

  it("handles nullish input", () => {
    expect(extractAvailableCategories(null)).toEqual([]);
    expect(extractAvailableCategories(undefined)).toEqual([]);
  });
});

describe("determineSuccess", () => {
  const none = [false, false, false, false, false];

  it("succeeds when a success heading is visible", async () => {
    const page = fakePage({ indicators: [true, false, false, false, false] });
    expect(await determineSuccess(page)).toBe(true);
  });

  it("succeeds when a success text is visible", async () => {
    const page = fakePage({ indicators: [false, false, true, false, false] });
    expect(await determineSuccess(page)).toBe(true);
  });

  it("succeeds when the dialog closed without a success message", async () => {
    const page = fakePage({ indicators: none, dialog: false });
    expect(await determineSuccess(page)).toBe(true);
  });

  it("fails when the dialog is still visible", async () => {
    const page = fakePage({ indicators: none, dialog: true });
    expect(await determineSuccess(page)).toBe(false);
  });

  it("treats a dialog lookup error as success", async () => {
    const page = fakePage({ indicators: none, dialog: new Error("boom") });
    expect(await determineSuccess(page)).toBe(true);
  });

  it("skips indicators that throw and checks the rest", async () => {
    const page = fakePage({
      indicators: [new Error("x"), true, false, false, false],
      dialog: true,
    });
    expect(await determineSuccess(page)).toBe(true);
  });
});

describe("extractReportCount", () => {
  it("returns null for null/undefined", () => {
    expect(extractReportCount(null)).toBeNull();
    expect(extractReportCount(undefined)).toBeNull();
  });

  it("parses a plain number", () => {
    expect(extractReportCount(42)).toBe(42);
    expect(extractReportCount("42")).toBe(42);
    expect(extractReportCount("  152 ")).toBe(152);
  });

  it("parses comma-separated numbers", () => {
    expect(extractReportCount("1,234")).toBe(1234);
  });

  it("parses labeled counts", () => {
    expect(extractReportCount("152 reports")).toBe(152);
    expect(extractReportCount("count: 7")).toBe(7);
    expect(extractReportCount("problems=3")).toBe(3);
  });

  it("falls back to first number", () => {
    expect(extractReportCount("abc 99 xyz")).toBe(99);
  });

  it("returns null when no number", () => {
    expect(extractReportCount("no digits here")).toBeNull();
  });
});

describe("hasReportCountIncreased", () => {
  it("returns true when after > before", () => {
    expect(hasReportCountIncreased(10, 11)).toBe(true);
  });

  it("returns false when equal or decreased", () => {
    expect(hasReportCountIncreased(10, 10)).toBe(false);
    expect(hasReportCountIncreased(10, 9)).toBe(false);
  });

  it("handles strings and nulls", () => {
    expect(hasReportCountIncreased("10", "11")).toBe(true);
    expect(hasReportCountIncreased(null, 5)).toBe(false);
    expect(hasReportCountIncreased(5, null)).toBe(false);
  });

  it("extracts from text", () => {
    expect(hasReportCountIncreased("10 reports", "11 reports")).toBe(true);
  });
});

describe("getReportCount", () => {
  it("returns null for null page", async () => {
    expect(await getReportCount(null)).toBeNull();
  });

  it("reads direct property", async () => {
    expect(await getReportCount({ count: 5 })).toBe(5);
    expect(await getReportCount({ reportCount: "7" })).toBe(7);
  });

  it("reads via getReportCount method", async () => {
    const page = { getReportCount: async () => "9 reports" };
    expect(await getReportCount(page)).toBe(9);
  });

  it("reads via textContent", async () => {
    const page = { textContent: async () => "count: 3" };
    expect(await getReportCount(page)).toBe(3);
  });
});

describe("determineSuccess count-based", () => {
  it("succeeds when count increased", async () => {
    const page = { count: 5 };
    expect(await determineSuccess(page, 4)).toBe(true);
  });

  it("falls back to heuristics when count not increased", async () => {
    const page = { count: 5 };
    expect(await determineSuccess(page, 5)).toBe(true);
  });

  it("supports object args", async () => {
    const page = { count: 6 };
    expect(await determineSuccess({ page, beforeCount: 5 })).toBe(true);
  });

  it("reads after count from page when missing", async () => {
    const page = { count: 6 };
    expect(await determineSuccess(page, 5, undefined)).toBe(true);
  });
});
