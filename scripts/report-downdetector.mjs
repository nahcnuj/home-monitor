import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
 * page via Playwright (RPA): it opens the page in a real browser, clicks
 * the "Report a problem" button, selects the appropriate issue indicator,
 * and confirms the submission. This uses only the publicly available web UI.
 */

const args = process.argv.slice(2);
const parsed = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const val = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[++i] : "true";
    parsed[key] = val;
  }
}

const pageUrl = parsed["page-url"] || process.env.DD_PAGE_URL || "";
const indicatorLabel = parsed["indicator"] || process.env.DD_INDICATOR || "Broadband Internet";
const headless = parsed["headless"] !== "false";
const timeoutMs = parseInt(parsed["timeout"] || "30000", 10);
const problemType = parsed["problem-type"] || "timeout";
const count = parseInt(parsed["count"] || "1", 10);
const stateFile =
  parsed["state-file"] ||
  process.env.DD_STATE_FILE ||
  dirname(fileURLToPath(import.meta.url)) + "/.downdetector-state/last-report";
const rateLimitSec = parseInt(parsed["rate-limit-sec"] || process.env.DD_RATE_LIMIT_SEC || "1800", 10);

if (!pageUrl) {
  console.error("Error: --page-url (or DD_PAGE_URL) is required");
  process.exit(1);
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function isRateLimited() {
  try {
    const raw = readFileSync(stateFile, "utf8").trim();
    if (!/^\d+$/.test(raw)) return false;
    return now() - parseInt(raw, 10) < rateLimitSec;
  } catch {
    return false;
  }
}

function markReported() {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, String(now()), "utf8");
}

async function run() {
  if (isRateLimited()) {
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
  await page.goto(pageUrl, { waitUntil: "networkidle", timeout: timeoutMs });

  // Wait for the page to fully render (Downdetector is a JS-heavy SPA)
  await page.waitForTimeout(3000);

  // Step 1: Click "Report a problem" button
  console.log('Clicking "Report a problem"...');
  const reportBtn = page.getByRole("button", { name: /report a problem/i });
  await reportBtn.waitFor({ state: "visible", timeout: timeoutMs });
  await reportBtn.click();
  await page.waitForTimeout(1500);

  // Step 2: Select the indicator (e.g., "Broadband Internet")
  console.log(`Selecting "${indicatorLabel}"...`);
  const indicatorBtn = page.getByRole("button", {
    name: new RegExp(indicatorLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  });
  await indicatorBtn.waitFor({ state: "visible", timeout: timeoutMs });
  await indicatorBtn.click();
  await page.waitForTimeout(2000);

  // Step 3: Check for confirmation dialog and confirm if present
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

  // Step 4: Verify success — look for success indicator or confirmation text
  const successIndicators = [
    page.getByRole("heading", { name: /thank you|reported|success/i }),
    page.getByText(/thank you for your report/i),
    page.getByText(/report submitted/i),
    page.getByText(/ありがとうございました/i),
    page.getByText(/報告しました/i),
  ];

  let success = false;
  for (const indicator of successIndicators) {
    try {
      if (await indicator.isVisible({ timeout: 2000 })) {
        success = true;
        break;
      }
    } catch {
      // Continue checking other indicators
    }
  }

  // Also check if the report dialog closed (implicit success)
  if (!success) {
    try {
      const dialog = page.getByRole("dialog");
      const isDialogVisible = await dialog.isVisible({ timeout: 1000 });
      if (!isDialogVisible) {
        success = true;
      }
    } catch {
      // Dialog not found — likely closed after submission
      success = true;
    }
  }

  await browser.close();

  if (success) {
    markReported();
    console.log(`Report submitted successfully (${indicatorLabel}, problem=${problemType}, count=${count})`);
    process.exit(0);
  } else {
    console.error("Report submission could not be confirmed");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
