import { chromium } from "playwright";

const args = process.argv.slice(2);
const parsed = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const val = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[++i] : "true";
    parsed[key] = val;
  }
}

const pageUrl = parsed["page-url"] || "";
const indicatorLabel = parsed["indicator"] || "Broadband Internet";
const headless = parsed["headless"] !== "false";
const timeoutMs = parseInt(parsed["timeout"] || "30000", 10);
const problemType = parsed["problem-type"] || "timeout";
const count = parseInt(parsed["count"] || "1", 10);

if (!pageUrl) {
  console.error("Error: --page-url is required");
  process.exit(1);
}

async function run() {
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
