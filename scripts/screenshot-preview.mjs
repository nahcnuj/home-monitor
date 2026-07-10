/**
 * Capture README screenshots (30m range): PC + mobile.
 *
 * Prerequisites:
 *   1. node scripts/generate-sample-tsv.mjs --local
 *   2. npm run dev  (http://localhost:5173)
 *   3. npm i -D playwright && npx playwright install chromium  (once)
 *   4. node scripts/screenshot-preview.mjs
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(root, "assets");
const outPc = path.join(assetsDir, "dashboard-preview-pc.png");
const outMobile = path.join(assetsDir, "dashboard-preview-mobile.png");

// Prefer localhost: on some Windows setups Vite binds IPv6-only and 127.0.0.1 fails.
const BASE = process.env.DASHBOARD_URL ?? "http://localhost:5173/";

/** PC layout: min-width 1000px / min-height 600px (style.css). */
const PC = { width: 1024, height: 720, deviceScaleFactor: 1 };
/** Typical phone; stays in compact / mobile-first layout. */
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2 };

async function prepareDashboard(page) {
  await page.addInitScript(() => {
    localStorage.setItem("dns-monitor-display-range-sec", String(30 * 60));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#latencyChart");
  await page.waitForSelector(".range-btn");
  await page.waitForSelector(".stats-bar .stat-item");
  await page.waitForSelector("#uptimeBadge .value");

  const active = (await page.locator(".range-btn.active").textContent())?.trim();
  if (active !== "30m") {
    await page.click('.range-btn[data-seconds="1800"]');
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(1800);
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{ width: number; height: number; deviceScaleFactor: number }} viewport
 * @param {string} outPath
 */
async function capture(browser, viewport, outPath) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
  });
  try {
    await prepareDashboard(page);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(
      "wrote",
      outPath,
      "active=",
      (await page.locator(".range-btn.active").textContent())?.trim(),
    );
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });
try {
  await capture(browser, PC, outPc);
  await capture(browser, MOBILE, outMobile);
} finally {
  await browser.close();
}
