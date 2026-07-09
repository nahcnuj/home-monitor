import { describe, expect, it } from "vitest";
import { monitorConfig } from "./config.ts";
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

  it("describes current error codes in one line but not legacy timeout", () => {
    expect(formatErrorDescription("job_timeout")).toBe(
      `設定 ${monitorConfig.job_timeout_sec}秒で打ち切り（nslookup 未完了）`,
    );
    expect(formatErrorDescription("dns_timeout")).toBe(
      `設定 ${monitorConfig.lookup_timeout_sec}秒まで再試行した末に DNS timeout`,
    );
    expect(formatErrorDescription("no_response")).toBe(
      `設定 ${monitorConfig.lookup_timeout_sec}秒まで再試行した末に No response from server`,
    );
    expect(formatErrorDescription("timeout")).toBeUndefined();
  });

  it("detects dns error dataset labels", () => {
    expect(isDnsErrorCode("job_timeout")).toBe(true);
    expect(isDnsErrorCode("203.165.31.152")).toBe(false);
  });
});