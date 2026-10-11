import { describe, expect, it, vi } from "vitest";
import { buildArgs, parseTargets, reportAll } from "../report-downdetector-targets.mjs";

const target = (overrides = {}) => ({
  service: "J:COM",
  page_url: "https://downdetector.jp/shougai/jcom/",
  indicator_label: "Broadband Internet",
  problem_type: "timeout",
  count: 3,
  ...overrides,
});

describe("parseTargets", () => {
  it("parses a JSON array of targets", () => {
    const raw = JSON.stringify([target()]);
    expect(parseTargets(raw)).toEqual({ targets: [target()] });
  });

  it("returns an error for invalid JSON", () => {
    const result = parseTargets("{not json");
    expect(result.error).toMatch(/^Invalid DD_TARGETS JSON:/);
  });

  it("returns no targets for empty input", () => {
    expect(parseTargets("")).toEqual({ targets: [] });
    expect(parseTargets("[]")).toEqual({ targets: [] });
  });

  it("returns no targets for a non-array value", () => {
    expect(parseTargets('{"service": "J:COM"}')).toEqual({ targets: [] });
  });
});

describe("buildArgs", () => {
  it("builds the RPA script CLI arguments", () => {
    expect(
      buildArgs("/scripts/report-downdetector.mjs", target(), "/state/last-report"),
    ).toEqual([
      "/scripts/report-downdetector.mjs",
      "--page-url",
      "https://downdetector.jp/shougai/jcom/",
      "--indicator",
      "Broadband Internet",
      "--problem-type",
      "timeout",
      "--count",
      "3",
      "--state-file",
      "/state/last-report",
    ]);
  });

  it("stringifies non-string field values", () => {
    const args = buildArgs("rpa.mjs", target({ page_url: 1, indicator_label: 2, problem_type: 3, count: 4 }), "state");
    expect(args).toEqual([
      "rpa.mjs",
      "--page-url",
      "1",
      "--indicator",
      "2",
      "--problem-type",
      "3",
      "--count",
      "4",
      "--state-file",
      "state",
    ]);
  });
});

describe("reportAll", () => {
  it("runs the RPA script once per target", () => {
    const execFileSync = vi.fn();
    const targets = [target(), target({ problem_type: "high_latency", count: 1 })];

    const failed = reportAll(targets, {
      execFileSync,
      scriptPath: "rpa.mjs",
      stateFile: "state",
    });

    expect(failed).toBe(0);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [
        "rpa.mjs",
        "--page-url",
        "https://downdetector.jp/shougai/jcom/",
        "--indicator",
        "Broadband Internet",
        "--problem-type",
        "timeout",
        "--count",
        "3",
        "--state-file",
        "state",
      ],
      { stdio: "inherit" },
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      expect.arrayContaining(["--problem-type", "high_latency", "--count", "1"]),
      { stdio: "inherit" },
    );
  });

  it("logs a success line per target", () => {
    const logs = [];
    const execFileSync = vi.fn();
    reportAll([target()], {
      execFileSync,
      scriptPath: "rpa.mjs",
      stateFile: "state",
      log: (msg) => logs.push(msg),
    });
    expect(logs).toEqual([
      "Downdetector report ok: J:COM (timeout, count=3)",
    ]);
  });

  it("continues after a failure and counts failures", () => {
    const errors = [];
    const execFileSync = vi.fn((_cmd, args) => {
      if (args.includes("timeout")) throw new Error("boom");
    });
    const targets = [
      target(),
      target({ problem_type: "high_latency", count: 1 }),
    ];

    const failed = reportAll(targets, {
      execFileSync,
      scriptPath: "rpa.mjs",
      stateFile: "state",
      error: (msg) => errors.push(msg),
    });

    expect(failed).toBe(1);
    expect(errors).toEqual(["Downdetector report failed for J:COM: boom"]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
