/**
 * End-to-end check that the Downdetector report flow can actually submit a
 * report (issue #111 review feedback). Runs the real RPA script against the
 * configured Downdetector pages. Because a successful run submits a real
 * report, this is only invoked from the dedicated workflow, which is itself
 * gated on changes to the report implementation or this test.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

function readConfig() {
  const raw = execFileSync("npx", ["tsx", "scripts/read-config.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(raw);
}

function main() {
  const cfg = readConfig();
  const dd = cfg.downdetector || {};
  const services = dd.services || {};
  const serviceByResolver = dd.service_by_resolver || {};
  // Report for every configured service that has a page_url.
  const targets = [];
  for (const [service, svc] of Object.entries(services)) {
    if (svc && svc.page_url) {
      targets.push({
        service,
        page_url: svc.page_url,
        indicator_label: svc.indicator_label,
        problem_type: "high_latency",
        count: 1,
      });
    }
  }
  if (targets.length === 0) {
    console.log("No Downdetector services configured");
    process.exit(0);
  }

  const stateDir = mkdtempSync(join(tmpdir(), "dd-e2e-"));
  const stateFile = join(stateDir, "last-report");
  let failed = 0;
  for (const target of targets) {
    const args = [
      join(here, "report-downdetector.mjs"),
      "--page-url",
      String(target.page_url),
      "--indicator",
      Array.isArray(target.indicator_label)
        ? target.indicator_label.map(String).join(", ")
        : String(target.indicator_label),
      "--problem-type",
      target.problem_type,
      "--count",
      String(target.count),
      "--state-file",
      stateFile,
      "--rate-limit-sec",
      "0",
    ];
    try {
      execFileSync(process.execPath, args, { stdio: "inherit" });
      console.log(`E2E report ok: ${target.service}`);
    } catch (err) {
      failed += 1;
      console.error(`E2E report failed for ${target.service}: ${err.message}`);
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}