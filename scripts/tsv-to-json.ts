/**
 * Convert dns-latency.tsv → dns-latency.json (DnsRecord[]).
 *
 * Usage:
 *   npx tsx scripts/tsv-to-json.ts [input.tsv] [output.json]
 * Defaults: docs/data/dns-latency.tsv → docs/data/dns-latency.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTsv } from "../dashboard/src/data.ts";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const inputPath = resolve(root, process.argv[2] ?? "docs/data/dns-latency.tsv");
const outputPath = resolve(root, process.argv[3] ?? "docs/data/dns-latency.json");

const text = readFileSync(inputPath, "utf8");
const records = parseTsv(text.length ? text : "");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(records)}\n`, "utf8");
console.log(`wrote ${outputPath} (${records.length} records)`);
