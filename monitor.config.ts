export interface MonitorConfig {
  domains: readonly string[];
  lookup_timeout_sec: number;
  /** Outer Wait-Job kill limit (seconds). Should exceed nslookup doubled-retry wall time. */
  job_timeout_sec: number;
  data_cutoff_ts: number;
  display_hours: number;
  publish_interval_min: number;
  publish_max_attempts: number;
  publish_retry_delays_sec: readonly number[];
  /** Downdetector reporting (latency >= threshold or dns/job_timeout) */
  downdetector: {
    /** Resolver DNS server IP (TSV col 2) => Downdetector service name.
     *  A record is reported only when its resolver is a key here, so a changed
     *  ISP/DNS server is never guessed. */
    service_by_resolver: Readonly<Record<string, string>>;
    /** High latency threshold in ms for a Downdetector alert */
    latency_threshold_ms: number;
    /** Downdetector data-api base URL. This is the endpoint the status page's
     *  "report a problem" button uses (Downdetector has no public write API). */
    data_api_url: string;
    /** Report target per service name (a value in service_by_resolver).
     *  company_id: Downdetector company id; indicator_id: problem indicator id
     *  shown on the status page (11 = 固定電話のインターネット / fixed-line internet);
     *  page_url: status page used to get a view token. Ids are per company, so
     *  both must be configured per service. */
    services: Readonly<Record<string, {
      company_id: string;
      indicator_id: number;
      page_url: string;
    }>>;
  };
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
  lookup_timeout_sec: 60,
  job_timeout_sec: 70,
  data_cutoff_ts: 1782000000, // 2026-06-21 09:00 JST
  display_hours: 24,
  publish_interval_min: 10,
  publish_max_attempts: 3,
  publish_retry_delays_sec: [30, 60, 120],
  downdetector: {
    service_by_resolver: {
      "203.165.31.152": "J:COM",
    },
    latency_threshold_ms: 1000,
    data_api_url: "https://data-api.downdetector.com",
    services: {
      "J:COM": {
        company_id: "33478",
        indicator_id: 11, // 固定電話のインターネット (fixed-line internet)
        page_url: "https://downdetector.jp/shougai/jcom/",
      },
    },
  },
} as const satisfies MonitorConfig;
