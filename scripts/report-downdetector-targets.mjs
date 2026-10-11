/**
 * Report bad DNS records to Downdetector from GitHub Actions (issue #30).
 *
 * The Sync DNS Data workflow detects newly inserted records from the last
 * hour that have high latency (>= downdetector.latency_threshold_ms) or
 * timed out, groups them by service, and passes the targets here as JSON
 * (DD_TARGETS env var). Each target drives the public Downdetector status
 * page via Playwright RPA (see report-downdetector.mjs).
 *
 * Runs in the cloud, not on the home PC: when the home DNS is broken the
 * PC often cannot reach Downdetector, so the report must be submitted from
 * GitHub Actions. Reporting is best-effort — a failure is logged and does
 * not fail the data sync.
 *
 * Usage:
 *   DD_TARGETS='[{...}]' node scripts/report-downdetector-targets.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, ".downdetector-state");

let targets = [];
try {
  targets = JSON.parse(process.env.DD_TARGETS || "[]");
} catch (err) {
  console.error(`Invalid DD_TARGETS JSON: ${err.message}`);
  process.exit(0);
}

if (!Array.isArray(targets) || targets.length === 0) {
  console.log("No Downdetector targets");
  process.exit(0);
}

mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, "last-report");

let failed = 0;
for (const target of targets) {
  const args = [
    join(here, "report-downdetector.mjs"),
    "--page-url",
    String(target.page_url),
    "--indicator",
    String(target.indicator_label),
    "--problem-type",
    String(target.problem_type),
    "--count",
    String(target.count),
    "--state-file",
    stateFile,
  ];
  try {
    execFileSync(process.execPath, args, { stdio: "inherit" });
    console.log(
      `Downdetector report ok: ${target.service} (${target.problem_type}, count=${target.count})`,
    );
  } catch (err) {
    failed += 1;
    console.error(`Downdetector report failed for ${target.service}: ${err.message}`);
  }
}

// Never fail the workflow: reporting must not block the data sync.
process.exit(0);
