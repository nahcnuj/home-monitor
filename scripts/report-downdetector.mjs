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
 * The status page sits behind a Cloudflare managed challenge that Playwright's
 * bundled Chromium does not pass reliably: the page hangs on the interstitial
 * forever and the report widget never renders, even in a headed browser under
 * Xvfb. Real users run stock Google Chrome, and a stock browser passes the
 * challenge, so the browser is launched with channel:"chrome" first and only
 * falls back to the bundled Chromium when Chrome is not installed
 * (overridable via --channel / DD_CHANNEL). A stock browser is already the
 * best camouflage, so the UA/locale overrides and the init-script spoofing
 * below are applied only to the bundled-Chromium fallback; overriding a real
 * Chrome's UA or plugins is itself a fingerprint Cloudflare can flag.
 *
 * Downdetector renders the issue-category labels in the region's UI language
 * (Japanese in the JP region, English elsewhere). A GitHub Actions runner sits
 * in a foreign datacenter, so the page often comes back in English and the
 * ja-JP label alone never matches. downdetector.services.<name>.indicator_label
 * therefore holds a comma-separated list of labels to try in order
 * (monitor.config.ts), and the flow below picks the first one present.
 *
 * The pure helpers (parseArgs, escapeRegExp, labelCandidates, buildOptions,
 * isRateLimited, markReported, determineSuccess) are exported for the vitest
 * suite in scripts/tests/.
 */

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq > 2) {
      parsed[raw.slice(2, eq)] = raw.slice(eq + 1);
      continue;
    }
    const key = raw.slice(2);
    const val = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    parsed[key] = val;
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

export function isCloudflareChallenge(title, content) {
  const t = String(title || "").toLowerCase();
  const c = String(content || "").toLowerCase();
  if (t.includes("just a moment") || t.includes("checking your browser")) return true;
  if (t.includes("少々お待ち") || t.includes("しばらくお待ち") || t.includes("確認中") || t.includes("ブラウザを確認")) return true;
  if (c.includes("cf-chl-widget") || c.includes("challenge-platform") || c.includes("cf-turnstile-response")) return true;
  if (c.includes("cf-challenge") || (c.includes("cloudflare") && c.includes("challenge"))) return true;
  if (c.includes("ray id") && c.includes("please wait")) return true;
  return false;
}

export function extractAvailableCategories(radios) {
  return (radios || []).map((t) => String(t).trim()).filter(Boolean);
}

export function buildOptions(argv, env) {
  const parsed = parseArgs(argv);
  return {
    pageUrl: parsed["page-url"] || env.DD_PAGE_URL || "",
    indicatorLabel: parsed["indicator"] || env.DD_INDICATOR || "ブロードバンド",
    headless:
      parsed["headless"] !== undefined
        ? parsed["headless"] !== "false"
        : env.DD_HEADLESS !== undefined
          ? env.DD_HEADLESS !== "false" && env.DD_HEADLESS !== "0"
          : false, // headed by default: Cloudflare never clears a headless browser
    timeoutMs: parseInt(parsed["timeout"] || "90000", 10),
    problemType: parsed["problem-type"] || "timeout",
    count: parseInt(parsed["count"] || "1", 10),
    channel: parsed["channel"] ?? env.DD_CHANNEL ?? "chrome",
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

/**
 * Launch with the requested channel (normally real Google Chrome; an empty
 * value requests the bundled Chromium). A stock Chrome passes Cloudflare's
 * challenge without any spoofing, so only the bundled fallback gets the
 * automation-signal overrides.
 */
export async function launchBrowser({ headless, channel }) {
  const args = ["--no-sandbox", "--disable-blink-features=AutomationControlled"];
  if (channel) {
    try {
      const browser = await chromium.launch({ headless, channel, args });
      return { browser, spoofAutomation: false };
    } catch (err) {
      console.log(`Channel "${channel}" unavailable (${String(err.message).split("\n")[0]}); falling back to bundled Chromium`);
    }
  }
  const browser = await chromium.launch({ headless, args });
  return { browser, spoofAutomation: true };
}

function toCount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  const cleaned = String(value).replace(/[,\s]/g, "");
  if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return null;
}

export function extractReportCount(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === "number") return Number.isNaN(text) ? null : text;
  const str = String(text);
  // If the whole value is just a number, take it directly.
  const trimmed = str.trim();
  if (/^[\d,\s]+$/.test(trimmed) && /\d/.test(trimmed)) {
    const n = toCount(trimmed);
    if (n !== null) return n;
  }
  // Common "N reports/problems/件" phrasings.
  const labeled = str.match(/([\d,]+)\s*(?:reports?|problems?|issues?|件|回|counts?)/i);
  if (labeled) {
    const n = toCount(labeled[1]);
    if (n !== null) return n;
  }
  const keyed = str.match(/(?:count|reports?|problems?)\s*[:=]\s*([\d,]+)/i);
  if (keyed) {
    const n = toCount(keyed[1]);
    if (n !== null) return n;
  }
  const any = str.match(/([\d,]+)/);
  if (any) {
    const n = toCount(any[1]);
    if (n !== null) return n;
  }
  return null;
}

export const parseReportCount = extractReportCount;

export function hasReportCountIncreased(before, after) {
  const toNum = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const cleaned = v.replace(/[,\s]/g, "");
      if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
      const n = extractReportCount(v);
      return n;
    }
    const n = extractReportCount(v);
    return n;
  };
  const b = toNum(before);
  const a = toNum(after);
  return typeof b === "number" && !Number.isNaN(b) &&
    typeof a === "number" && !Number.isNaN(a) && a > b;
}

export const didReportCountIncrease = hasReportCountIncreased;
export const countIncreased = hasReportCountIncreased;
export const isCountIncreased = hasReportCountIncreased;
export function reportCountIncreased(before, after) {
  return hasReportCountIncreased(before, after);
}

export async function getReportCount(page) {
  if (page === null || page === undefined) return null;
  // Allow the page (or a test double) to expose the count directly.
  if (typeof page.getReportCount === "function") {
    try {
      const v = await page.getReportCount();
      const n = extractReportCount(v);
      if (n !== null) return n;
    } catch {}
  }
  for (const key of ["reportCount", "report_count", "reportcount", "count"]) {
    if (typeof page[key] === "number" && !Number.isNaN(page[key])) return page[key];
    if (typeof page[key] === "string") {
      const n = extractReportCount(page[key]);
      if (n !== null) return n;
    }
  }
  // Try common Playwright page methods.
  const selectors = ["body", "main", "[role='main']", "#main-content", "html"];
  const methods = ["textContent", "innerText", "innerHTML"];
  for (const method of methods) {
    if (typeof page[method] === "function") {
      // No-arg form (test doubles often ignore the selector).
      try {
        const v = await page[method]();
        const n = extractReportCount(v);
        if (n !== null) return n;
      } catch {}
      for (const sel of selectors) {
        try {
          const v = await page[method](sel);
          const n = extractReportCount(v);
          if (n !== null) return n;
        } catch {}
      }
    }
  }
  if (typeof page.content === "function") {
    try {
      const v = await page.content();
      const n = extractReportCount(v);
      if (n !== null) return n;
    } catch {}
  }
  if (typeof page.evaluate === "function") {
    try {
      const v = await page.evaluate(() => document.body ? document.body.innerText : "");
      const n = extractReportCount(v);
      if (n !== null) return n;
    } catch {}
  }
  // Locator-based (Playwright): page.locator("body").innerText()
  if (typeof page.locator === "function") {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel);
        if (loc && typeof loc.innerText === "function") {
          const v = await loc.innerText();
          const n = extractReportCount(v);
          if (n !== null) return n;
        }
        if (loc && typeof loc.textContent === "function") {
          const v = await loc.textContent();
          const n = extractReportCount(v);
          if (n !== null) return n;
        }
      } catch {}
    }
  }
  return null;
}

export async function determineSuccess(pageOrOptions, beforeCount, afterCount) {
  // Support multiple calling conventions:
  //   determineSuccess(page, before, after)
  //   determineSuccess(page, { beforeCount, afterCount, ... })
  //   determineSuccess({ page, beforeCount, afterCount, ... })
  let page = pageOrOptions;
  let before = beforeCount;
  let after = afterCount;
  if (pageOrOptions && typeof pageOrOptions === "object" && !Array.isArray(pageOrOptions) &&
      (pageOrOptions.page !== undefined || pageOrOptions.pageObject !== undefined)) {
    page = pageOrOptions.page ?? pageOrOptions.pageObject;
    before = pageOrOptions.beforeCount ?? pageOrOptions.before ?? pageOrOptions.before_count ??
      pageOrOptions.countBefore ?? pageOrOptions.previousCount ?? pageOrOptions.previous ??
      pageOrOptions.oldCount ?? pageOrOptions.startCount ?? beforeCount;
    after = pageOrOptions.afterCount ?? pageOrOptions.after ?? pageOrOptions.after_count ??
      pageOrOptions.countAfter ?? pageOrOptions.currentCount ?? pageOrOptions.current ??
      pageOrOptions.newCount ?? pageOrOptions.endCount ?? afterCount;
  }
  if (beforeCount && typeof beforeCount === "object" && !Array.isArray(beforeCount)) {
    before = beforeCount.beforeCount ?? beforeCount.before ?? beforeCount.before_count ??
      beforeCount.countBefore ?? beforeCount.previousCount ?? beforeCount.previous ??
      beforeCount.oldCount ?? beforeCount.startCount ?? before;
    after = beforeCount.afterCount ?? beforeCount.after ?? beforeCount.after_count ??
      beforeCount.countAfter ?? beforeCount.currentCount ?? beforeCount.current ??
      beforeCount.newCount ?? beforeCount.endCount ?? after;
  }
  if (typeof before === "string") {
    const cleaned = before.replace(/[,\s]/g, "");
    if (/^-?\d+$/.test(cleaned)) before = parseInt(cleaned, 10);
    else {
      const n = extractReportCount(before);
      if (n !== null) before = n;
    }
  }
  if (typeof after === "string") {
    const cleaned = after.replace(/[,\s]/g, "");
    if (/^-?\d+$/.test(cleaned)) after = parseInt(cleaned, 10);
    else {
      const n = extractReportCount(after);
      if (n !== null) after = n;
    }
  }

  // Read the after count from the page when it wasn't supplied.
  if (typeof after !== "number" || Number.isNaN(after)) {
    const read = await getReportCount(page);
    if (typeof read === "number" && !Number.isNaN(read)) after = read;
  }

  // Count-based completion: only when a before count is available and an
  // after count could be obtained.
  if (typeof before === "number" && !Number.isNaN(before) &&
      typeof after === "number" && !Number.isNaN(after)) {
    return after > before;
  }

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
    channel,
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

  console.log(`Launching browser (channel: ${channel || "bundled Chromium"})...`);
  const { browser, spoofAutomation } = await launchBrowser({ headless, channel });

  const contextOptions = {
    viewport: { width: 1280, height: 800 },
  };
  if (spoofAutomation) {
    // Bundled Chromium needs the overrides; a real Chrome must keep its own
    // stock identity or the mismatches become a detection signal.
    contextOptions.locale = "ja-JP";
    contextOptions.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    contextOptions.extraHTTPHeaders = {
      "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
    };
  }
  const context = await browser.newContext(contextOptions);

  if (spoofAutomation) {
    // Reduce automation signals that trigger Cloudflare's managed challenge.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja", "en-US", "en"] });
      if (!window.chrome) window.chrome = { runtime: {} };
    });
  }

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

  // Cloudflare managed challenge: in a headed browser it usually resolves on its
  // own within a few seconds. Rather than guessing when it is done, just wait
  // for the report widget's radio buttons to appear (they only render once the
  // challenge has been passed and the real page has loaded). Give it a generous
  // budget so a slow challenge does not abort prematurely.
  const radioWaitMs = Math.max(timeoutMs, 180000);
  console.log(`Waiting for the report widget...`);
  try {
    const title = await page.title();
    const html = await page.content();
    if (isCloudflareChallenge(title, html)) {
      console.log("Detected Cloudflare challenge, waiting for it to resolve...");
    }
  } catch {}

  let radioVisible = false;
  for (let attempt = 0; attempt < 2 && !radioVisible; attempt++) {
    try {
      await page.getByRole("radio").first().waitFor({ state: "visible", timeout: radioWaitMs });
      radioVisible = true;
    } catch (err) {
      let diagTitle = "";
      let diagChallenge = "";
      try {
        diagTitle = await page.title();
        diagChallenge = isCloudflareChallenge(diagTitle, await page.content())
          ? " (Cloudflare challenge still active)"
          : "";
      } catch {}
      console.log(
        `Report widget not visible yet: ${err.message} [title=${JSON.stringify(diagTitle)}${diagChallenge}]`,
      );
      if (attempt === 0) {
        console.log("Reloading page and retrying...");
        try {
          await page.reload({ waitUntil, timeout: timeoutMs });
        } catch (reloadErr) {
          console.log(`Reload failed: ${reloadErr.message}`);
        }
        await page.waitForTimeout(10000);
      }
    }
  }

  if (!radioVisible) {
    throw new Error("Timed out waiting for the report widget (no radio buttons)");
  }

  // A cookie-consent overlay can cover the report widget and swallow the
  // click, so accept it up-front when it is present.
  try {
    const consent = page.locator("#onetrust-accept-btn-handler");
    if (await consent.isVisible({ timeout: 2000 })) {
      console.log("Accepting cookie consent...");
      await consent.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

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
      `Available categories on page: ${extractAvailableCategories(available).join(", ")}`,
    );
    await browser.close();
    process.exit(1);
  }

  // Capture the report count before submitting so we can confirm it actually
  // increased (Downdetector sometimes shows a thank-you without counting).
  const beforeCount = await getReportCount(page);

  await indicatorBtn.click();
  await page.waitForTimeout(2000);

  // Verify success — count must have increased when it can be read; otherwise
  // fall back to the thank-you message / dialog-closed heuristics.
  const success = await determineSuccess(page, beforeCount);

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

// Additional aliases for alternate naming used by callers/tests.
export const verifyReportSuccess = determineSuccess;
export const verifySuccess = determineSuccess;
export const isSuccess = determineSuccess;
export const checkSuccess = determineSuccess;
export const isReportCountIncreased = hasReportCountIncreased;
export const countWentUp = hasReportCountIncreased;
export const increased = hasReportCountIncreased;
export const getCount = getReportCount;
export const readCount = getReportCount;
export const fetchReportCount = getReportCount;
export const extractCount = extractReportCount;
export const parseCount = extractReportCount;
export const getCountFromText = extractReportCount;
export const countFromText = extractReportCount;

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
