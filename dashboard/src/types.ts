export type DnsErrorCode =
  | "job_timeout"
  | "dns_timeout"
  | "timeout"
  | "no_response"
  | "no_nameserver"
  | "server_fail"
  | "refused"
  | "nxdomain"
  | "no_record"
  | "resolver_error"
  | "unknown"
  | string;

export interface DnsSuccessRecord {
  ts: number;
  dns_server: string;
  domain: string | null;
  latency_ms: number;
  error?: undefined;
}

export interface DnsFailureRecord {
  ts: number;
  dns_server: string;
  domain: string | null;
  error: DnsErrorCode;
  duration_ms?: number;
  latency_ms?: undefined;
}

export type DnsRecord = DnsSuccessRecord | DnsFailureRecord;

export interface AggregatedSuccess {
  dns_server: string;
  ts: number;
  latency_ms: number;
}

export interface Stats {
  total: number;
  uptime: number;
  avg: number;
  p95: number;
  max: number;
  errors: Record<string, number>;
}

export interface TimeBounds {
  /** Left edge of the full chart (may extend past one viewport when history exists). */
  min: number;
  /** Right edge of the chart (aligned “now”). */
  max: number;
  /** Full chart span in seconds (max - min). */
  range: number;
  /**
   * How many seconds of time the plot viewport width represents (selected range preset).
   * Used for horizontal zoom: chart CSS width ∝ range / viewportSec.
   */
  viewportSec: number;
  tickStep: number;
}

export interface RangePreset {
  seconds: number;
  label: string;
}

export interface ChartPoint {
  x: number;
  y: number | null;
}

export interface LatencySamplePoint {
  x: number;
  y: number;
  domain: string | null;
}

export interface FailurePoint {
  x: number;
  y: number;
  error: DnsErrorCode;
  dns_server: string;
  domain: string | null;
  duration_ms?: number;
}

export interface TimeoutRange {
  start: number;
  end: number;
}





