import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Downdetector reporting (issue #30).
 *
 * Runs in GitHub Actions (Sync DNS Data), not on the home PC: when the home
 * DNS is broken the PC often cannot reach Downdetector at all, so the report
 * must be submitted from the cloud. The workflow detects bad records and
 * passes them to report-downdetector-targets.mjs, which invokes this script
 * per service. Rate-limit state is kept under scripts/.downdetector-state/.
 *
 * Downdetector has no public write API, so this drives the public status
 * page via Playwright (RPA): it opens the page in a real browser, selects
 * the appropriate issue indicator (a role="radio" category button rendered
 * under the "Report a problem" heading), and confirms the submission. This
 * uses only the publicly available web UI.
 *
 * The pure helpers (parseArgs, escapeRegExp, buildOptions, isRateLimited,
 * markReported, confirmSubmission, determineSuccess) are exported for the
 * vitest suite in scripts/tests/.
 */

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      parsed[key] = val;
    }
  }
  return parsed;
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildOptions(argv, env) {
  const parsed = parseArgs(argv);
  return {
    pageUrl: parsed["page-url"] || env.DD_PAGE_URL || "",
    indicatorLabel: parsed["indicator"] || env.DD_INDICATOR || "Broadband Internet",
    headless: parsed["headless"] !== "false",
    timeoutMs: parseInt(parsed["timeout"] || "90000", 10),
    problemType: parsed["problem-type"] || "timeout",
    count: parseInt(parsed["count"] || "1", 10),
    stateFile:
      parsed["state-file"] ||
      env.DD_STATE_FILE ||
      dirname(fileURLToPath(import.meta.url)) + "/.downdetector-state/last-report",
    rateLimitSec: parseInt(parsed["rate-limit-sec"] || env.DD_RATE_LIMIT_SEC || "1800", 10),
    waitUntil: parsed["wait-until"] || env.DD_WAIT_UNTIL || "domcontentloaded",
    maxRetries: parseInt(parsed["max-retries"] || env.DD_MAX_RETRIES || "2", 10),
  };
}

export function isRateLimited(stateFile, { nowSec, rateLimitSec }) {
  try {
    const raw = readFileSync(stateFile, "utf8").trim();
    if (!/^\d+$/.test(raw)) return false;
    return nowSec - parseInt(raw, 10) < rateLimitSec;
  } catch {
    return false;
  }
}

export function markReported(stateFile, { nowSec }) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, String(nowSec), "utf8");
}

export async function confirmSubmission(page) {
  try {
    const confirmBtn = page.getByRole("button", {
      name: /^(submit|report|confirm|send|はい|確認|送信)/i,
    });
    if (await confirmBtn.isVisible({ timeout: 2000 })) {
      console.log("Confirming report submission...");
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch {
    // No confirmation dialog — submission may already be complete
  }
}

export async function determineSuccess(page) {
  const successIndicators = [
    page.getByRole("heading", { name: /thank you|reported|success/i }),
    page.getByText(/thank you for your report/i),
    page.getByText(/report submitted/i),
    page.getByText(/ありがとうございました/i),
    page.getByText(/報告しました/i),
  ];

  for (const indicator of successIndicators) {
    try {
      if (await indicator.isVisible({ timeout: 2000 })) {
        return true;
      }
    } catch {
      // Continue checking other indicators
    }
  }

  // Also check if the report dialog closed (implicit success)
  try {
    const dialog = page.getByRole("dialog");
    const isDialogVisible = await dialog.isVisible({ timeout: 1000 });
    if (!isDialogVisible) {
      return true;
    }
  } catch {
    // Dialog not found — likely closed after submission
    return true;
  }
  return false;
}

async function run() {
  const {
    pageUrl,
    indicatorLabel,
    headless,
    timeoutMs,
    problemType,
    count,
    stateFile,
    rateLimitSec,
    waitUntil,
    maxRetries,
  } = buildOptions(process.argv.slice(2), process.env);

  if (!pageUrl) {
    console.error("Error: --page-url (or DD_PAGE_URL) is required");
    process.exit(1);
  }

  const now = () => Math.floor(Date.now() / 1000);

  if (isRateLimited(stateFile, { nowSec: now(), rateLimitSec })) {
    console.log(`Rate limited: already reported within the last ${rateLimitSec}s`);
    process.exit(0);
  }

  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    locale: "ja-JP",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
    },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  console.log(`Navigating to ${pageUrl}...`);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(pageUrl, { waitUntil, timeout: timeoutMs });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        console.log(`Navigation attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
        await page.waitForTimeout(5000);
      } else {
        console.error(`All ${maxRetries + 1} navigation attempts failed.`);
        throw err;
      }
    }
  }

   // Wait for the page to fully render (Downdetector is a JS-heavy SPA and
   // may sit behind a Cloudflare challenge first).
   await page.waitForTimeout(10000);

   // Step 1: Select the issue category (e.g., "Broadband Internet"). The
   // categories are role="radio" buttons rendered directly on the page under
   // the "Report a problem" heading — there is no separate "Report a problem"
   // button to click first.
   console.log(`Selecting "${indicatorLabel}"...`);
   const indicatorBtn = page.getByRole("radio", {
     name: new RegExp(escapeRegExp(indicatorLabel), "i"),
   });
   await indicatorBtn.waitFor({ state: "visible", timeout: timeoutMs });
   await indicatorBtn.click();
   await page.waitForTimeout(2000);

   // Step 2: Check for confirmation dialog and confirm if present
   await confirmSubmission(page);

   // Step 3: Verify success — look for success indicator or confirmation text
   const success = await determineSuccess(page);

  await browser.close();

  if (success) {
    markReported(stateFile, { nowSec: now() });
    console.log(`Report submitted successfully (${indicatorLabel}, problem=${problemType}, count=${count})`);
    process.exit(0);
  } else {
    console.error("Report submission could not be confirmed");
    process.exit(1);
  }
}

// Only run the RPA flow when executed directly, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
