export interface MonitorConfig {
  domains: readonly string[];
  lookup_timeout_sec: number;
  data_cutoff_ts: number;
  display_hours: number;
}

export const monitorConfig = {
  domains: [
    "google.com",
    "cloudflare.com",
    "github.com",
    "amazon.co.jp",
    "yahoo.co.jp",
    "apple.com",
    "microsoft.com",
    "line.me",
    "203-165-31-152.rev.home.ne.jp",
  ],
  lookup_timeout_sec: 15,
  data_cutoff_ts: 1782000000, // 2026-06-21 09:00 JST
  display_hours: 24,
} as const satisfies MonitorConfig;