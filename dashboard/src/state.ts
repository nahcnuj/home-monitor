import { DEFAULT_DISPLAY_RANGE_SEC } from "./constants.ts";
import type { DnsRecord } from "./types.ts";

export let dataCutoffTs = 0;
export let displayRangeSec = DEFAULT_DISPLAY_RANGE_SEC;
export let allRecords: DnsRecord[] = [];
export let rangeSelectorReady = false;

export function setDataCutoffTs(value: number): void {
  dataCutoffTs = value;
}

export function setDisplayRangeSec(value: number): void {
  displayRangeSec = value;
}

export function setAllRecords(records: DnsRecord[]): void {
  allRecords = records;
}

export function setRangeSelectorReady(value: boolean): void {
  rangeSelectorReady = value;
}