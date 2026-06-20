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
  ],
  lookup_timeout_sec: 15,
  data_cutoff_ts: 1781967600,
  display_hours: 24,
} as const satisfies MonitorConfig;