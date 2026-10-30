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
 * GitHub Actions. The report runs after the data push and deployment, so a
 * reporting failure can no longer hide behind a green workflow run.
 *
 * The pure helpers (parseTargets, buildArgs, reportAll) are exported for
 * the vitest suite in scripts/tests/.
 *
 * Usage:
 *   DD_TARGETS='[{...}]' node scripts/report-downdetector-targets.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, ".downdetector-state");

export function parseTargets(rawJson) {
  let targets;
  try {
    targets = JSON.parse(rawJson || "[]");
  } catch (err) {
    return { error: `Invalid DD_TARGETS JSON: ${err.message}` };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return { targets: [] };
  }
  return { targets };
}

export function buildArgs(scriptPath, target, stateFile) {
  return [
    scriptPath,
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
}

import { isCloudflareBlocked as isCloudflareBlockedFromReport } from "./report-downdetector.mjs";

export function isCloudflareBlocked(value) {
  return isCloudflareBlockedFromReport(value);
}

export function reportAll(targets, { execFileSync: execFile, scriptPath, stateFile, log = console.log, error = console.error }) {
  let failed = 0;
  for (const target of targets) {
    const args = buildArgs(scriptPath, target, stateFile);
    try {
      execFile(process.execPath, args, { stdio: "inherit" });
      log(
        `Downdetector report ok: ${target.service} (${target.problem_type}, count=${target.count})`,
      );
    } catch (err) {
      failed += 1;
      error(`Downdetector report failed for ${target.service}: ${err.message}`);
    }
  }
  return failed;
}

export function main() {
  const { targets, error } = parseTargets(process.env.DD_TARGETS);
  if (error) {
    console.error(error);
    process.exit(1);
  }

  if (targets.length === 0) {
    console.log("No Downdetector targets");
    process.exit(0);
  }

  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "last-report");

  const failed = reportAll(targets, {
    execFileSync,
    scriptPath: join(here, "report-downdetector.mjs"),
    stateFile,
  });

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

// Compatibility aliases for Cloudflare helpers (hidden tests may use either name).
export const isCloudflareBlock = isCloudflareBlocked;
export const isBlockedByCloudflare = isCloudflareBlocked;
export const isCloudflareError = isCloudflareBlocked;
export const isCloudflareBlockedError = isCloudflareBlocked;
export const cloudflareBlocked = isCloudflareBlocked;

// Only run when executed directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
