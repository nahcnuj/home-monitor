import { describe, expect, it } from "vitest";
import {
  formatErrorCode,
  formatErrorDescription,
  isDnsErrorCode,
  isTimeoutError,
} from "./errors.ts";

describe("error codes", () => {
  it("maps known codes to Japanese labels", () => {
    expect(formatErrorCode("job_timeout")).toBe("計測タイムアウト");
    expect(formatErrorCode("dns_timeout")).toBe("DNSタイムアウト");
    expect(formatErrorCode("no_response")).toBe("応答なし");
  });

  it("recognizes timeout variants for outage shading", () => {
    expect(isTimeoutError("job_timeout")).toBe(true);
    expect(isTimeoutError("dns_timeout")).toBe(true);
    expect(isTimeoutError("timeout")).toBe(true);
    expect(isTimeoutError("no_response")).toBe(false);
  });

  it("describes current error codes but not legacy timeout", () => {
    expect(formatErrorDescription("job_timeout")).toContain("計測側");
    expect(formatErrorDescription("dns_timeout")).toContain("nslookup");
    expect(formatErrorDescription("no_response")).toBeTruthy();
    expect(formatErrorDescription("timeout")).toBeUndefined();
  });

  it("detects dns error dataset labels", () => {
    expect(isDnsErrorCode("job_timeout")).toBe(true);
    expect(isDnsErrorCode("203.165.31.152")).toBe(false);
  });
});