/**
 * End-to-end check that the Downdetector report flow can actually submit a
 * report (issue #111 review feedback). Runs the real RPA script against the
 * configured Downdetector pages. Because a successful run submits a real
 * report, this is only invoked from the dedicated workflow, which is itself
 * gated on changes to the report implementation or this test.
 *
 * Reporting goes through the same orchestrator as the Sync DNS Data workflow
 * (report-downdetector-targets.mjs / reportAll) so the method and expected
 * result match production exactly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportAll } from "./report-downdetector-targets.mjs";

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
    throw new Error("No Downdetector services configured");
  }

  const stateDir = mkdtempSync(join(tmpdir(), "dd-e2e-"));
  const stateFile = join(stateDir, "last-report");
  const failed = reportAll(targets, {
    execFileSync,
    scriptPath: join(here, "report-downdetector.mjs"),
    stateFile,
    rateLimitSec: 0,
  });
  rmSync(stateDir, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!invokedDirectly) {
  throw new Error("unreachable");
}
main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
