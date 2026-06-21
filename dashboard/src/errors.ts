export const DNS_ERROR_CODES = new Set([
  "job_timeout",
  "dns_timeout",
  "timeout",
  "no_response",
  "no_nameserver",
  "server_fail",
  "refused",
  "nxdomain",
  "no_record",
  "resolver_error",
  "unknown",
]);

export const ERROR_LABELS: Record<string, string> = {
  job_timeout: "計測タイムアウト",
  dns_timeout: "DNSタイムアウト",
  timeout: "タイムアウト（旧）",
  no_response: "応答なし",
  no_nameserver: "DNS未設定",
  server_fail: "サーバー失敗",
  refused: "クエリ拒否",
  nxdomain: "ドメイン不存在",
  no_record: "レコードなし",
  resolver_error: "リゾルバ解決失敗",
  unknown: "不明",
};

export function isDnsErrorCode(code: string | undefined): code is string {
  return typeof code === "string" && DNS_ERROR_CODES.has(code);
}

export function isTimeoutError(code: string): boolean {
  return code === "timeout" || code === "job_timeout" || code === "dns_timeout";
}

export function formatErrorCode(code: string): string {
  return ERROR_LABELS[code] ?? code;
}