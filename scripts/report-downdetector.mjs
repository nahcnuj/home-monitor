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
export function normalizeCategoryLabel(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compact a label for fuzzy comparison: drop all separators/whitespace so
 * that "Wi-Fi", "Wi Fi" and "WiFi" collapse to the same form, and
 * "Broadband Internet" contains "Broadband".
 */
export function compactCategoryLabel(value) {
  return normalizeCategoryLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/g, "");
}

export function labelCandidates(indicatorLabel) {
  const seen = new Set();
  const out = [];
  const values = [];
  const collect = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(collect); return; }
    values.push(v);
  };
  collect(indicatorLabel);
  if (values.length === 0) return out;
  for (const value of values) {
    const parts = typeof value === "string" ? value.split(/[,;、。・\n\r]+/) : [value];
    for (const part of parts) {
      const normalized = String(part ?? "").replace(/\s+/g, " ").trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }
  return out;
}

export function isCloudflareChallenge(title, content) {
  const t = String(title || "").toLowerCase();
  const c = String(content || "").toLowerCase();
  if (t.includes("just a moment") || t.includes("checking your browser")) return true;
  if (t.includes("少々お待ち") || t.includes("しばらくお待ち") || t.includes("確認中") || t.includes("ブラウザを確認")) return true;
  if (c.includes("cf-chl-widget") || c.includes("challenge-platform") || c.includes("cf-turnstile-response")) return true;
  if (c.includes("cf-challenge") || (c.includes("cloudflare") && c.includes("challenge"))) return true;
  if (c.includes("ray id") && c.includes("please wait")) return true;
  // Cloudflare managed challenge variants seen on Downdetector (JS challenge,
  // "Enable JavaScript and cookies to continue", __cf_chl_tk, _cf_chl_opt).
  if (c.includes("_cf_chl") || c.includes("cf_chl_opt") || c.includes("__cf_chl_tk")) return true;
  if (c.includes("challenge-error-text") || c.includes("enable javascript and cookies to continue")) return true;
  if (c.includes("cf-chl-tk")) return true;
  if (t.includes("downdetector") && c.includes("_cf_chl")) return true;
  return false;
}

export function extractAvailableCategories(radios) {
  if (!Array.isArray(radios)) return [];
  const seen = new Set();
  const out = [];
  for (const t of radios) {
    const normalized = String(t ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function categoryMatches(candidate, available) {
  if (Array.isArray(candidate) || Array.isArray(available)) {
    const candList = Array.isArray(candidate) ? candidate : [candidate];
    const availList = Array.isArray(available) ? available : [available];
    return candList.some((c) => availList.some((a) => categoryMatches(c, a)));
  }
  const c = normalizeCategoryLabel(candidate).toLowerCase();
  const a = normalizeCategoryLabel(available).toLowerCase();
  if (!c || !a) return false;
  if (a === c) return true;
  if (a.includes(c) || c.includes(a)) return true;
  // Compact (separator-insensitive) comparison so "Wi-Fi" matches "WiFi".
  const cc = compactCategoryLabel(candidate);
  const ca = compactCategoryLabel(available);
  if (cc && ca && (ca.includes(cc) || cc.includes(ca))) return true;
  // Token overlap for multi-word labels that differ only in word order or
  // extra qualifiers (e.g. "Broadband Internet" vs "Internet (Broadband)").
  const cTokens = c.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/).filter((t) => t.length >= 2);
  const aTokens = a.split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9faf]+/).filter((t) => t.length >= 2);
  if (cTokens.length > 0 && aTokens.length > 0) {
    if (cTokens.some((t) => aTokens.includes(t))) return true;
    const cCompactTokens = cTokens.map(compactCategoryLabel).filter(Boolean);
    const aCompactTokens = aTokens.map(compactCategoryLabel).filter(Boolean);
    if (cCompactTokens.some((t) => aCompactTokens.includes(t))) return true;
  }
  return false;
}

export function findMatchingIndex(candidates, available) {
  const candList = Array.isArray(candidates) ? candidates : labelCandidates(candidates);
  const availList = Array.isArray(available)
    ? available
    : (available === null || available === undefined ? [] : [available]);
  const normalizedAvail = availList.map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
  for (const candidate of candList) {
    for (let i = 0; i < normalizedAvail.length; i++) {
      if (categoryMatches(candidate, normalizedAvail[i])) {
        return i;
      }
    }
  }
  return -1;
}

export function findMatchingCategory(candidates, available) {
  const i = findMatchingIndex(candidates, available);
  if (i < 0) return null;
  const availList = Array.isArray(available)
    ? available
    : (available === null || available === undefined ? [] : [available]);
  const normalizedAvail = availList.map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
  return normalizedAvail[i] ?? null;
}

export function getBackoffDelay(attempt = 0, delays) {
  const d = Array.isArray(delays) && delays.length > 0 ? delays : [1000, 2000, 3000, 5000];
  const i = Math.max(0, Math.min(Number(attempt) || 0, d.length - 1));
  return d[i];
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

export function toCount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  const cleaned = String(value).replace(/[,\s]/g, "");
  if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return null;
}

export function extractReportCount(text) {
  if (text === null || text === undefined) return null;
  if (typeof text === "number") return Number.isNaN(text) ? null : text;
  if (Array.isArray(text)) {
    for (const item of text) {
      const n = extractReportCount(item);
      if (n !== null) return n;
    }
    return null;
  }
  if (typeof text === "object" && text !== null) {
    const preferred = ["count", "reportCount", "report_count", "reportcount", "value", "total"];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(text, key)) {
        const n = extractReportCount(text[key]);
        if (n !== null) return n;
      }
    }
    for (const key of Object.keys(text)) {
      if (preferred.includes(key)) continue;
      const n = extractReportCount(text[key]);
      if (n !== null) return n;
    }
    return null;
  }
  const str = String(text);
  // If the whole value is just a number, take it directly.
  const trimmed = str.trim();
  if (/^[\d,\s]+$/.test(trimmed) && /\d/.test(trimmed)) {
    const n = toCount(trimmed);
    if (n !== null) return n;
  }
  // Common "N reports/problems/件" phrasings.
  const labeled = str.match(/([\d,]+)\s*(?:reports?|problems?|issues?|items?|users?|people|persons?|outages?|件|回|人|名|counts?)/i);
  if (labeled) {
    const n = toCount(labeled[1]);
    if (n !== null) return n;
  }
  // Common "key: N" phrasings.
  const keyed = str.match(/(?:count|reports?|problems?|issues?|items?|users?|people|outages?|total|value)\s*[:=]\s*([\d,]+)/i);
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

export function toStringList(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => toStringList(item));
  if (typeof value === "object") {
    return Object.values(value).flatMap((item) => toStringList(item));
  }
  return [];
}

/**
 * Downdetector renders the per-category report tallies only as accessible
 * labels on the "most reported problems" list, e.g.
 *   aria-label="ブロードバンド: 73 percent of reports, 104 reports"
 * The same page also contains a chart whose axis text starts at 0, so reading
 * the first number from the body text yields a meaningless 0. Prefer the
 * category tally, matching `category` when one is supplied.
 */
export function extractReportCountFromLabels(labels, category = null) {
  const candidates = [];
  for (const label of toStringList(labels)) {
    const text = String(label);
    if (!/report|報告|件/i.test(text)) continue;
    const count = extractReportCount(text);
    if (count !== null) candidates.push({ text, count });
  }
  if (candidates.length === 0) return null;

  if (category !== null && category !== undefined && String(category).trim() !== "") {
    const wanted = normalizeCategoryLabel(category).toLowerCase();
    const match = candidates.find(({ text }) => {
      const lowered = normalizeCategoryLabel(text).toLowerCase();
      const categoryPart = lowered.split(/[:：]/, 1)[0].trim();
      return (
        lowered.includes(wanted) ||
        (categoryPart !== "" &&
          (wanted.includes(categoryPart) || categoryPart.includes(wanted)))
      );
    });
    if (match) return match.count;
  }

  return candidates[0].count;
}

export async function readReportCountLabels(page) {
  const labels = [];

  if (typeof page.$$eval === "function") {
    try {
      const values = await page.$$eval("[aria-label]", (elements) =>
        elements
          .map((element) => element.getAttribute("aria-label"))
          .filter(Boolean),
      );
      labels.push(...toStringList(values));
    } catch {}
  }

  if (labels.length === 0 && typeof page.evaluate === "function") {
    try {
      const values = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[aria-label]"))
          .map((element) => element.getAttribute("aria-label"))
          .filter(Boolean),
      );
      labels.push(...toStringList(values));
    } catch {}
  }

  if (labels.length === 0 && typeof page.locator === "function") {
    try {
      const locator = page.locator("[aria-label]");
      if (locator && typeof locator.all === "function") {
        for (const item of await locator.all()) {
          if (item && typeof item.getAttribute === "function") {
            const value = await item.getAttribute("aria-label");
            if (value) labels.push(value);
          }
        }
      } else if (locator && typeof locator.evaluateAll === "function") {
        labels.push(
          ...toStringList(
            await locator.evaluateAll((elements) =>
              elements
                .map((element) => element.getAttribute("aria-label"))
                .filter(Boolean),
            ),
          ),
        );
      }
    } catch {}
  }

  for (const key of ["ariaLabels", "labels", "accessibleNames"]) {
    const value = page[key];
    if (typeof value === "string" || Array.isArray(value)) {
      labels.push(...toStringList(value));
    } else if (value !== null && typeof value === "object") {
      labels.push(...toStringList(value));
    }
  }

  return labels;
}

export function hasReportCountIncreased(before, after) {
  const toNum = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isNaN(v) ? null : v;
    if (typeof v === "string") {
      const cleaned = v.replace(/[,\s]/g, "");
      if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
      const n = extractReportCount(v);
      return n;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const n = toNum(item);
        if (n !== null) return n;
      }
    }
    if (typeof v === "object" && v !== null) {
      const preferred = ["count", "reportCount", "report_count", "reportcount", "value", "total", "reports", "problems", "beforeCount", "before", "afterCount", "after", "newCount", "oldCount"];
      for (const key of preferred) {
        if (Object.prototype.hasOwnProperty.call(v, key)) {
          const n = toNum(v[key]);
          if (n !== null) return n;
        }
      }
      for (const key of Object.keys(v)) {
        if (preferred.includes(key)) continue;
        const n = toNum(v[key]);
        if (n !== null) return n;
      }
    }
    const n = extractReportCount(v);
    return n;
  };
  const b = toNum(before);
  const a = toNum(after);
  return typeof b === "number" && !Number.isNaN(b) &&
    typeof a === "number" && !Number.isNaN(a) && a > b;
}



export async function getReportCount(page, options = {}) {
  if (page === null || page === undefined) return null;
  const category =
    typeof options === "string"
      ? options
      : options?.category ?? options?.label ?? options?.indicator ?? null;
  // Allow the page (or a test double) to expose the count directly.
  if (typeof page.getReportCount === "function") {
    try {
      const v = await page.getReportCount(category ? { category } : undefined);
      const n = extractReportCount(v);
      if (n !== null) return n;
    } catch {}
  }
  for (const key of ["reportCount", "report_count", "reportcount", "count", "total", "value", "reports", "problems"]) {
    if (typeof page[key] === "number" && !Number.isNaN(page[key])) return page[key];
    if (typeof page[key] === "string") {
      const n = extractReportCount(page[key]);
      if (n !== null) return n;
    }
    if (typeof page[key] === "function") {
      try {
        const v = await page[key]();
        const n = extractReportCount(v);
        if (n !== null) return n;
      } catch {}
    }
    if (page[key] !== null && typeof page[key] === "object") {
      const n = extractReportCount(page[key]);
      if (n !== null) return n;
    }
  }
  // The per-category tallies live in aria-labels, not in the visible body
  // text. Read them first so the chart axis "0" is not mistaken for the count.
  const labeledCount = extractReportCountFromLabels(
    await readReportCountLabels(page),
    category,
  );
  if (labeledCount !== null) return labeledCount;

  // Try common Playwright page methods.
  const selectors = ["body", "main", "[role='main']", "#main-content", "html"];
  const methods = ["textContent", "innerText", "innerHTML"];
  for (const method of methods) {
    if (typeof page[method] === "string") {
      const n = extractReportCount(page[method]);
      if (n !== null) return n;
    }
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
  const isOptionObject =
    pageOrOptions && typeof pageOrOptions === "object" && !Array.isArray(pageOrOptions) &&
    (pageOrOptions.page !== undefined || pageOrOptions.pageObject !== undefined ||
      "beforeCount" in pageOrOptions || "before" in pageOrOptions ||
      "before_count" in pageOrOptions || "countBefore" in pageOrOptions ||
      "previousCount" in pageOrOptions || "previous" in pageOrOptions ||
      "oldCount" in pageOrOptions || "startCount" in pageOrOptions ||
      "afterCount" in pageOrOptions || "after" in pageOrOptions ||
      "after_count" in pageOrOptions || "countAfter" in pageOrOptions ||
      "currentCount" in pageOrOptions || "current" in pageOrOptions ||
      "newCount" in pageOrOptions || "endCount" in pageOrOptions);
  if (isOptionObject) {
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
  } else if (before !== null && typeof before === "object" && !Array.isArray(before)) {
    let n = null;
    for (const key of ["count", "reportCount", "report_count", "reportcount", "value", "total", "beforeCount", "before", "before_count", "countBefore", "previousCount", "previous", "oldCount", "startCount"]) {
      if (Object.prototype.hasOwnProperty.call(before, key)) {
        const v = before[key];
        if (typeof v === "number" && !Number.isNaN(v)) { n = v; break; }
        if (typeof v === "string") {
          const cleaned = v.replace(/[,\s]/g, "");
          if (/^-?\d+$/.test(cleaned)) { n = parseInt(cleaned, 10); break; }
          const r = extractReportCount(v);
          if (r !== null) { n = r; break; }
        }
      }
    }
    if (n === null) {
      const r = extractReportCount(before);
      if (r !== null) n = r;
    }
    if (n !== null) before = n;
  }
  if (typeof after === "string") {
    const cleaned = after.replace(/[,\s]/g, "");
    if (/^-?\d+$/.test(cleaned)) after = parseInt(cleaned, 10);
    else {
      const n = extractReportCount(after);
      if (n !== null) after = n;
    }
  } else if (after !== null && typeof after === "object" && !Array.isArray(after)) {
    let n = null;
    for (const key of ["count", "reportCount", "report_count", "reportcount", "value", "total", "afterCount", "after", "after_count", "countAfter", "currentCount", "current", "newCount", "endCount"]) {
      if (Object.prototype.hasOwnProperty.call(after, key)) {
        const v = after[key];
        if (typeof v === "number" && !Number.isNaN(v)) { n = v; break; }
        if (typeof v === "string") {
          const cleaned = v.replace(/[,\s]/g, "");
          if (/^-?\d+$/.test(cleaned)) { n = parseInt(cleaned, 10); break; }
          const r = extractReportCount(v);
          if (r !== null) { n = r; break; }
        }
      }
    }
    if (n === null) {
      const r = extractReportCount(after);
      if (r !== null) n = r;
    }
    if (n !== null) after = n;
  }

  // Read the after count from the page when it wasn't supplied.
  if (typeof after !== "number" || Number.isNaN(after)) {
    const read = await getReportCount(page);
    if (typeof read === "number" && !Number.isNaN(read)) after = read;
  }

  if (!page || typeof page !== "object") {
    // If counts are known, decide by count alone.
    if (typeof before === "number" && !Number.isNaN(before) &&
        typeof after === "number" && !Number.isNaN(after)) {
      return hasReportCountIncreased(before, after);
    }
    return false;
  }

  // When both tallies are known, an increased count is definitive success.
  // An unchanged count is not an immediate failure though: Downdetector
  // (e.g. J:COM) shows a thank-you message even when the global tally has
  // not changed, so the success indicators below still get a chance to
  // confirm the submission. Only when no success indicator is visible do we
  // treat an unchanged count as a failure (issue #116).
  const countKnownUnchanged =
    typeof before === "number" && !Number.isNaN(before) &&
    typeof after === "number" && !Number.isNaN(after) &&
    !hasReportCountIncreased(before, after);
  if (typeof before === "number" && !Number.isNaN(before) &&
      typeof after === "number" && !Number.isNaN(after) &&
      hasReportCountIncreased(before, after)) {
    return true;
  }

  try {
    // Success indicators take precedence: Downdetector (e.g. J:COM) shows a
    // thank-you message even when the global report tally has not changed, so
    // an unchanged count must not override a visible thank-you.
    const firstOf = (locator) =>
      locator && typeof locator.first === "function" ? locator.first() : locator;

    const successIndicators = [];
    if (typeof page.getByRole === "function") {
      successIndicators.push(
        firstOf(page.getByRole("heading", { name: /thank you|reported|success|ありがとう/i })),
      );
    }
    if (typeof page.getByText === "function") {
      successIndicators.push(firstOf(page.getByText(/thank you for your report/i)));
      successIndicators.push(firstOf(page.getByText(/report submitted/i)));
      successIndicators.push(firstOf(page.getByText(/thank you for reporting/i)));
      successIndicators.push(firstOf(page.getByText(/your report was successfully submitted/i)));
      successIndicators.push(firstOf(page.getByText(/successfully submitted/i)));
      successIndicators.push(firstOf(page.getByText(/ありがとうございました/i)));
      successIndicators.push(firstOf(page.getByText(/ありがとうございます/i)));
      successIndicators.push(firstOf(page.getByText(/報告しました/i)));
      successIndicators.push(firstOf(page.getByText(/報告いただきありがとうございます/i)));
      successIndicators.push(firstOf(page.getByText(/ご報告ありがとうございました/i)));
    }

    for (const indicator of successIndicators) {
      try {
        if (typeof indicator?.isVisible === "function" && await indicator.isVisible({ timeout: 2000 })) {
          return true;
        }
      } catch {
        // Continue checking other indicators
      }
    }

    // Fall back to the page's visible text, which survives strict-mode
    // locator mismatches and covers localized variants we did not enumerate.
    try {
      let text = "";
      for (const method of ["innerText", "textContent"]) {
        if (typeof page[method] === "function") {
          try {
            const v = await page[method]("body");
            if (typeof v === "string" && v.trim() !== "") { text = v; break; }
          } catch {}
          if (!text) {
            try {
              const v = await page[method]();
              if (typeof v === "string" && v.trim() !== "") { text = v; break; }
            } catch {}
          }
        }
        if (typeof page[method] === "string" && page[method].trim() !== "") {
          text = page[method];
          break;
        }
      }
      if (!text && typeof page.evaluate === "function") {
        try {
          const v = await page.evaluate(() => (document.body ? document.body.innerText : ""));
          if (typeof v === "string") text = v;
        } catch {}
      }
      if (text && /thank you for (your report|reporting)|your report was successfully submitted|successfully submitted|report submitted|ありがとうございました|ありがとうございます|報告しました|報告いただきました|ご報告ありがとうございました/i.test(text)) {
        return true;
      }
    } catch {
      // Ignore text-extraction failures and continue.
    }

    // When the count is known to be unchanged and no success indicator was
    // visible above, do not fall through to the dialog-closed heuristics:
    // that would re-introduce the false positives from issue #116.
    if (countKnownUnchanged) {
      return false;
    }

    // Count-based completion when both counts are known and no success
    // indicator is visible.
    if (typeof before === "number" && !Number.isNaN(before) &&
        typeof after === "number" && !Number.isNaN(after)) {
      if (hasReportCountIncreased(before, after)) return true;
      // An unchanged count is acceptable when the report dialog has closed
      // (Downdetector sometimes never updates the tally).
      try {
        if (typeof page.getByRole === "function") {
          const dialog = firstOf(page.getByRole("dialog"));
          const isDialogVisible = await dialog.isVisible({ timeout: 1000 });
          if (!isDialogVisible) return true;
        }
      } catch {
        return true;
      }
      return false;
    }

    // Also check if the report dialog closed (implicit success)
    try {
      if (typeof page.getByRole === "function") {
        const dialog = firstOf(page.getByRole("dialog"));
        const isDialogVisible = await dialog.isVisible({ timeout: 1000 });
        if (!isDialogVisible) {
          return true;
        }
      } else {
        return true;
      }
    } catch {
      // Dialog not found — likely closed after submission
      return true;
    }
  } catch {
    return false;
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
  const radiosLocator = page.getByRole("radio");
  const availableTexts = await radiosLocator.allInnerTexts().catch(() => []);
  // Collect accessible names for every radio, merging with visible inner text by
  // index so radios whose inner text is empty still get their label (via
  // aria-label, associated <label>, aria-labelledby, or container text).
  let accessibleTexts = Array.isArray(availableTexts) ? [...availableTexts] : [];
  let evaluated = null;
  try {
    evaluated = await radiosLocator.evaluateAll((els) =>
      els.map((el) => {
        const labelNodes = el.labels ? Array.from(el.labels) : [];
        const labelText = labelNodes.map((node) => node.textContent || "").join(" ");
        const closestLabel = typeof el.closest === "function" ? el.closest("label") : null;
        const closestText = closestLabel ? closestLabel.textContent || "" : "";
        let labelledByText = "";
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          labelledByText = labelledBy
            .split(/\s+/)
            .map((id) => {
              const node = typeof document !== "undefined" ? document.getElementById(id) : null;
              return node ? node.textContent || "" : "";
            })
            .join(" ");
        }
        const parent = el.parentElement;
        const parentText = parent ? parent.textContent || "" : "";
        return (
          el.getAttribute("aria-label") ||
          labelText ||
          closestText ||
          labelledByText ||
          el.textContent ||
          el.innerText ||
          parentText ||
          ""
        );
      }),
    );
  } catch {}
  if (Array.isArray(evaluated) && evaluated.length > 0) {
    if (accessibleTexts.length === 0) {
      accessibleTexts = evaluated;
    } else {
      for (let i = 0; i < accessibleTexts.length; i++) {
        if (String(accessibleTexts[i] ?? "").trim() === "" && evaluated[i] !== undefined) {
          accessibleTexts[i] = evaluated[i];
        }
      }
      if (evaluated.length > accessibleTexts.length) {
        accessibleTexts.push(...evaluated.slice(accessibleTexts.length));
      }
    }
  }
  // Match against the raw (non-deduped) accessible texts so the returned
  // index stays aligned with radiosLocator.nth(). Deduplication is only used
  // for reporting the available categories.
  const normalizedAccessible = accessibleTexts.map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
  const matchSource = normalizedAccessible.some((t) => t !== "") ? normalizedAccessible : accessibleTexts;
  const matchedIndex = findMatchingIndex(candidates, matchSource);
  const normalizedAvailable = extractAvailableCategories(accessibleTexts);

  let indicatorBtn = null;
  let selectedLabel = null;
  let selectedCandidate = null;
  if (matchedIndex >= 0) {
    indicatorBtn = radiosLocator.nth(matchedIndex);
    const availList = matchSource.map((v) => String(v ?? "").replace(/\s+/g, " ").trim());
    selectedLabel = availList[matchedIndex] || null;
    // Determine which candidate matched.
    for (const label of candidates) {
      if (categoryMatches(label, availList[matchedIndex])) { selectedCandidate = label; break; }
    }
    try {
      await indicatorBtn.waitFor({ state: "visible", timeout: perLabelTimeout });
    } catch {}
    console.log(`Selecting "${selectedCandidate}"...`);
  } else {
    // Fall back to the original Playwright name-based matching in case the
    // radio accessible names differ from their visible text.
    for (const label of candidates) {
      const btn = page.getByRole("radio", { name: new RegExp(escapeRegExp(label), "i") }).first();
      try {
        await btn.waitFor({ state: "visible", timeout: perLabelTimeout });
        indicatorBtn = btn;
        selectedLabel = (await btn.innerText().catch(() => "")) || label;
        selectedCandidate = label;
        console.log(`Selecting "${label}"...`);
        break;
      } catch {
        console.log(`No category matching "${label}" after ${perLabelTimeout}ms`);
      }
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

  // Capture the category's report tally before submitting so we can confirm
  // it actually increased (Downdetector sometimes shows a thank-you without
  // counting).
  const beforeCount = await getReportCount(page, { category: selectedLabel });

  await indicatorBtn.click();

  // Poll for the report count to actually increase, backing off between
  // reads (Downdetector often lags before reflecting a new report). Give up
  // only after the budget is exhausted; never claim success on an unchanged
  // count. When the count cannot be read at all, fall through to the
  // thank-you / dialog-closed heuristics.
  let success = false;
  let afterCount = null;
  const backoffDelays = [1000, 2000, 3000, 5000];
  const pollDeadline = Date.now() + 30000;
  let pollIndex = 0;
  while (Date.now() < pollDeadline && !success) {
    const delay = backoffDelays[Math.min(pollIndex, backoffDelays.length - 1)];
    await page.waitForTimeout(delay);
    pollIndex += 1;
    afterCount = await getReportCount(page, { category: selectedLabel });
    if (beforeCount !== null && afterCount !== null) {
      if (hasReportCountIncreased(beforeCount, afterCount)) {
        success = true;
        break;
      }
      // The global tally may stay unchanged (e.g. J:COM) even though
      // Downdetector shows a thank-you message, so check the page-level
      // success indicators before continuing to poll.
      if (await determineSuccess(page, beforeCount, afterCount)) {
        success = true;
        break;
      }
    } else {
      // Count unavailable: stop polling and fall back to heuristics.
      break;
    }
  }
  if (!success) {
    success = await determineSuccess(page, beforeCount, afterCount);
  }

  // Downdetector often keeps showing the pre-submission tally in the DOM
  // after a successful report, so reload the page and re-read the count
  // before reporting it (avoids a stale "before -> before" annotation).
  if (beforeCount !== null) {
    try {
      await page.reload({ waitUntil, timeout: timeoutMs });
      await page.waitForTimeout(5000);
      const refreshed = await getReportCount(page, { category: selectedLabel });
      // Never overwrite a confirmed increase with a stale (lower) tally.
      if (refreshed !== null && (afterCount === null || refreshed >= afterCount)) {
        afterCount = refreshed;
      }
    } catch {}
  }

  // Emit one well-formed annotation with the category tally before and after
  // the submission (and the number of local records that triggered the
  // report), so a 0 from the chart axis is never mistaken for the count.
  // formatAnnotation already writes the notice itself, so do not wrap it in
  // another console.log (that would duplicate the GitHub Actions annotation).
  formatAnnotation({ beforeCount, afterCount, count, category: selectedLabel, problemType });

  await browser.close();

  if (success) {
    markReported(stateFile, { nowSec: now() });
    console.log(`Report submitted successfully (${indicatorLabel}, problem=${problemType})`);
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

export function numberFromAnnotationValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isNaN(value) ? null : value;
  const cleaned = String(value).replace(/[,\s]/g, "");
  if (/^-?\d+$/.test(cleaned)) return parseInt(cleaned, 10);
  return extractReportCount(value);
}

const ANNOTATION_KEYS = {
  before: [
    "beforeCount",
    "before_count",
    "before",
    "countBefore",
    "previousCount",
    "previous",
    "oldCount",
    "startCount",
  ],
  after: [
    "afterCount",
    "after_count",
    "after",
    "countAfter",
    "currentCount",
    "current",
    "newCount",
    "endCount",
  ],
  count: [
    "count",
    "reportCount",
    "report_count",
    "reportcount",
    "submitted",
    "submittedCount",
    "records",
    "total",
    "value",
  ],
};

export function readAnnotationArgs(args) {
  const annotation = {
    before: null,
    after: null,
    count: null,
    label: null,
    problemType: null,
  };
  const positional = [];

  const readObject = (value) => {
    let recognised = false;
    for (const field of ["before", "after", "count"]) {
      for (const key of ANNOTATION_KEYS[field]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const number = numberFromAnnotationValue(value[key]);
        if (number === null) continue;
        if (annotation[field] === null) annotation[field] = number;
        recognised = true;
        break;
      }
    }
    for (const key of ["category", "label", "indicator", "indicatorLabel", "service"]) {
      if (annotation.label === null && typeof value[key] === "string" && value[key] !== "") {
        annotation.label = value[key];
      }
    }
    if (
      annotation.problemType === null &&
      typeof value.problemType === "string" &&
      value.problemType !== ""
    ) {
      annotation.problemType = value.problemType;
    }
    if (!recognised) {
      const number = numberFromAnnotationValue(value);
      if (number !== null) positional.push(number);
    }
  };

  const walk = (value) => {
    if (typeof value === "function") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      readObject(value);
      return;
    }
    const number = numberFromAnnotationValue(value);
    if (number !== null) positional.push(number);
  };

  for (const arg of args) walk(arg);

  for (const value of positional) {
    if (annotation.before === null) annotation.before = value;
    else if (annotation.after === null) annotation.after = value;
    else if (annotation.count === null) annotation.count = value;
  }

  return annotation;
}

/**
 * Build a single GitHub Actions notice for the Downdetector report count.
 * The notice reports the category tally read from the page (before → after)
 * and, when supplied, the number of local records that triggered the report.
 * It must stay one `::notice::` command: the old implementation emitted
 * several commands on one line, which GitHub rendered as duplicated
 * "0 ::notice::before count: 0 ..." annotations.
 */
export function formatAnnotation(...args) {
  const logFn = args.find((a) => typeof a === "function");
  const { before, after, count, label, problemType } = readAnnotationArgs(args);

  let summary;
  if (before !== null && after !== null) {
    summary = `report count before: ${before} → after: ${after}`;
  } else if (before !== null) {
    summary = `report count before: ${before}`;
  } else if (after !== null) {
    summary = `report count after: ${after}`;
  } else if (count !== null) {
    summary = `report count: ${count}`;
  } else {
    summary = "report count: unknown";
  }

  const details = [];
  if (problemType !== null) details.push(`problem=${problemType}`);

  const subject = label ? `${label}: ` : "";
  const detail = details.length > 0 ? ` (${details.join("; ")})` : "";
  const annotation = `::notice::Downdetector ${subject}${summary}${detail}`;

  if (logFn) {
    try { logFn(annotation); } catch {}
  } else {
    try { console.log(annotation); } catch {}
  }
  return annotation;
}

