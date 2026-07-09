/**
 * Capture README eye-catch screenshot (30m range).
 *
 * Prerequisites:
 *   1. node scripts/generate-sample-tsv.mjs --local
 *   2. npm run dev  (http://127.0.0.1:5173)
 *   3. npm i -D playwright && npx playwright install chromium  (once)
 *   4. node scripts/screenshot-preview.mjs
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets/dashboard-preview.png");

const browser = await chromium.launch({ headless: true });
// Typical Full HD; avoid 2x DPR so the PNG stays roughly FHD-sized.
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});

await page.addInitScript(() => {
  localStorage.setItem("dns-monitor-display-range-sec", String(30 * 60));
});

await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
await page.waitForSelector("#latencyChart");
await page.waitForSelector(".range-btn");

const active = (await page.locator(".range-btn.active").textContent())?.trim();
if (active !== "30m") {
  await page.click('.range-btn[data-seconds="1800"]');
  await page.waitForTimeout(600);
}

await page.waitForTimeout(1800);
// Clip to the FHD viewport (not full-page scroll height).
await page.screenshot({ path: out, fullPage: false });
console.log(
  "wrote",
  out,
  "active=",
  (await page.locator(".range-btn.active").textContent())?.trim(),
);
await browser.close();
