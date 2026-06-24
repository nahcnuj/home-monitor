import type { RangePreset } from "./types.ts";

export const DEFAULT_DISPLAY_RANGE_SEC = 24 * 3600;
export const STORAGE_KEY = "dns-monitor-display-range-sec";
export const LEGACY_STORAGE_KEY = "dns-monitor-display-hours";

export const RANGE_PRESETS: RangePreset[] = [
  { seconds: 30 * 60, label: "30m" },
  { seconds: 3600, label: "1h" },
  { seconds: 3 * 3600, label: "3h" },
  { seconds: 6 * 3600, label: "6h" },
  { seconds: 12 * 3600, label: "12h" },
  { seconds: 24 * 3600, label: "24h" },
  { seconds: 72 * 3600, label: "3d" },
  { seconds: 168 * 3600, label: "7d" },
];

export const HOUR_SEC = 3600;
export const HIDE_LATENCY_POINTS_RANGE_SEC = 6 * HOUR_SEC;
export const MIN_SEC = 60;
export const DAY_SEC = 86400;
export const JST_OFFSET = 9 * HOUR_SEC;
export const MEASURE_INTERVAL_SEC = 60;
export const MAX_GAP_SEC = 3 * 60;

export const SERVER_COLORS = [
  "#5b8def",
  "#f59e0b",
  "#4ade80",
  "#a78bfa",
  "#f472b6",
  "#38bdf8",
] as const;

export const ERROR_COLORS: Record<string, string> = {
  job_timeout: "#ef4444",
  dns_timeout: "#dc2626",
  timeout: "#f87171",
  no_response: "#f97316",
  no_nameserver: "#f59e0b",
  server_fail: "#eab308",
  refused: "#a855f7",
  nxdomain: "#ec4899",
  no_record: "#6366f1",
  resolver_error: "#14b8a6",
  unknown: "#8b90a0",
};

export const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});