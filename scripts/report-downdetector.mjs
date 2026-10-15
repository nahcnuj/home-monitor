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
 * page via Playwright (RPA): it opens the page in a real browser and selects
 * the issue category (a role="radio" button rendered under the "問題を報告"
 * heading). Selecting the category submits the report immediately — the page
 * then shows a thank-you message; there is no separate submit button. This
 * uses only the publicly available web UI.
 *
 * The page is requested with the ja-JP locale, but Downdetector renders the
 * issue-category labels in the region's UI language (Japanese in the JP
 * region, English elsewhere). A GitHub Actions runner sits in a foreign
 * datacenter, so the page often comes back in English and the ja-JP label
 * alone never matches. downdetector.services.<name>.indicator_label therefore
 * holds a comma-separated list of labels to try in order (monitor.config.ts),
 * and the flow below picks the first one that is present on the page.
 *
 * The pure helpers (parseArgs, escapeRegExp, labelCandidates, buildOptions,
 * isRateLimited, markReported, determineSuccess) are exported for the vitest
 * suite in scripts/tests/.
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

/**
 * Split a comma-separated indicator_label into the individual on-page labels
 * to try, in order. Accepts a single label (no comma) too, so the config can
 * stay a plain string. Empty entries are dropped.
 */
export function labelCandidates(indicatorLabel) {
  return String(indicatorLabel)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildOptions(argv, env) {
  const parsed = parseArgs(argv);
  return {
    pageUrl: parsed["page-url"] || env.DD_PAGE_URL || "",
    indicatorLabel: parsed["indicator"] || env.DD_INDICATOR || "ブロードバンド",
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

export async function determineSuccess(page) {
  const successIndicators = [
    page.getByRole("heading", { name: /thank you|reported|success|ありがとう/i }),
    page.getByText(/thank you for your report/i),
    page.getByText(/report submitted/i),
    page.getByText(/ありがとうございました/i),
    page.getByText(/ありがとうございます/i),
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

  // Wait for the report widget to render, then select the issue category. The
  // categories are role="radio" buttons under the "問題を報告" (Report an issue)
  // heading — there is no separate "Report a problem" button to click first,
  // and selecting a category submits the report on its own.
  //
  // The labels are localized (Japanese in the JP region, English elsewhere), so
  // try every candidate until one is actually present on the page.
  console.log(`Waiting for the report widget...`);
  await page.getByRole("radio").first().waitFor({ state: "visible", timeout: timeoutMs });

  const candidates = labelCandidates(indicatorLabel);
  const perLabelTimeout = Math.max(8000, Math.floor(timeoutMs / candidates.length));
  let indicatorBtn = null;
  for (const label of candidates) {
    const btn = page.getByRole("radio", { name: new RegExp(escapeRegExp(label), "i") }).first();
    try {
      await btn.waitFor({ state: "visible", timeout: perLabelTimeout });
      indicatorBtn = btn;
      console.log(`Selecting "${label}"...`);
      break;
    } catch {
      console.log(`No category matching "${label}" after ${perLabelTimeout}ms`);
    }
  }

  if (!indicatorBtn) {
    const available = await page
      .getByRole("radio")
      .allInnerTexts()
      .catch(() => []);
    console.error(`No report category matched any of: ${candidates.join(", ")}`);
    console.error(
      `Available categories on page: ${available.map((t) => t.trim()).filter(Boolean).join(", ")}`,
    );
    await browser.close();
    process.exit(1);
  }

  await indicatorBtn.click();
  await page.waitForTimeout(2000);

  // Verify success — look for the thank-you message shown after reporting.
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
