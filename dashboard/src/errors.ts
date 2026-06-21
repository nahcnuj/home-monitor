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

export const ERROR_DESCRIPTIONS: Record<string, string> = {
  job_timeout: "計測側の待ち時間を超えて打ち切った。nslookup プロセスが終わらなかった。",
  dns_timeout: "nslookup が DNS 応答のタイムアウトを報告した。リゾルバまたは経路側の遅延・無応答。",
  no_response: "リゾルバから DNS 応答が返らなかった（UDP 53 の無応答）。",
  no_nameserver: "Windows に利用可能な DNS サーバーが設定されていない。",
  server_fail: "リゾルバがサーバーエラー（SERVFAIL 等）を返した。",
  refused: "リゾルバがクエリを拒否した。",
  nxdomain: "ドメインが存在しない（NXDOMAIN）。",
  no_record: "ドメインはあるが、問い合わせたレコード種別（A/AAAA 等）がない。",
  resolver_error: "指定したリゾルバ IP の名前解決に失敗した。",
  unknown: "上記のいずれにも当てはまらない nslookup エラー。",
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

export function formatErrorDescription(code: string): string | undefined {
  return ERROR_DESCRIPTIONS[code];
}