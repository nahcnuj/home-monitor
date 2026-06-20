import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

export function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

export const sampleTsv = readRepoFile("docs/data/dns-latency.tsv");