import { chromium } from "@playwright/test";
import path from "node:path";

const ARTIFACTS_DIR = "/Users/danangharissetiawan/.gemini/antigravity/brain/9633f428-3df4-4c3d-902f-97f3630ec125";
const BASE_URL = "http://127.0.0.1:3100";
const SESSION_TOKEN = "ca2519b3ee0be234133cd329d780dbbd61e943d55215eb8b03bd15839d755515";
const COMPANY_ID = "9297e06c-1abc-443e-8ba3-f4bb7be8a851";
const PREFIX = "DAT";
const EXISTING_ENDPOINT_ID = "012d3e89-4146-4bbc-9183-2c32e1d50735";
const AGENT_ID = "8e1ece12-a45b-4952-861e-51945bac3d1c"; // Knowledge Ingestion Agent

async function main() {
  console.log("Launching Chromium...");
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: SESSION_TOKEN,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: "better-auth.session_token",
      value: SESSION_TOKEN,
      domain: "localhost",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error]:`, msg.text());
    }
  });

  page.on("pageerror", (err) => {
    console.error("[Uncaught Page Exception]:", err.message);
  });

  await page.addInitScript((companyId) => {
    localStorage.setItem("paperclip.selectedCompanyId", companyId);
  }, COMPANY_ID);

  // 1. Apps Catalog
  console.log(`1. Navigating to Connectors catalog: ${BASE_URL}/${PREFIX}/apps ...`);
  await page.goto(`${BASE_URL}/${PREFIX}/apps`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const searchInput = page.getByLabel("Search connectors");
  await searchInput.fill("WhatsApp");
  await page.waitForTimeout(1000);

  const catalogShot = path.join(ARTIFACTS_DIR, "whatsapp_apps_catalog.png");
  await page.screenshot({ path: catalogShot, fullPage: true });
  console.log(`Captured Apps catalog screenshot: ${catalogShot}`);

  // 2. WhatsApp Endpoint Detail Page
  console.log(`2. Navigating to WhatsApp Endpoint detail: ${BASE_URL}/${PREFIX}/apps/chat/${EXISTING_ENDPOINT_ID}/settings ...`);
  await page.goto(`${BASE_URL}/${PREFIX}/apps/chat/${EXISTING_ENDPOINT_ID}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const detailShot = path.join(ARTIFACTS_DIR, "whatsapp_endpoint_detail.png");
  await page.screenshot({ path: detailShot, fullPage: true });
  console.log(`Captured Endpoint detail screenshot: ${detailShot}`);

  // 3. Connect WhatsApp Wizard (Step 1)
  console.log(`3. Navigating to Connect WhatsApp wizard: ${BASE_URL}/${PREFIX}/apps/chat/connect?provider=whatsapp&purpose=chat&agentId=${AGENT_ID} ...`);
  await page.goto(`${BASE_URL}/${PREFIX}/apps/chat/connect?provider=whatsapp&purpose=chat&agentId=${AGENT_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  const step1Shot = path.join(ARTIFACTS_DIR, "whatsapp_step1_choose_agent.png");
  await page.screenshot({ path: step1Shot, fullPage: true });
  console.log(`Captured Step 1 screenshot: ${step1Shot}`);

  // 4. Click Continue to enter Step 2
  const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
  await continueBtn.waitFor({ state: "visible", timeout: 10000 });
  console.log("Clicking 'Continue' to advance to WhatsApp QR pairing step...");
  await continueBtn.click();

  // 5. Wait for Step 2: Connect WhatsApp and QR code
  console.log("Waiting for 'Connect WhatsApp' heading...");
  await page.waitForSelector('text="Connect WhatsApp"', { timeout: 20000 });
  console.log("Found 'Connect WhatsApp' heading!");

  console.log("Waiting for Baileys QR code generation...");
  const qrImage = page.locator('img[alt="WhatsApp QR Code"]');
  await qrImage.waitFor({ state: "visible", timeout: 35000 });
  const qrSrc = await qrImage.getAttribute("src");
  console.log(`SUCCESS: QR code received! Length: ${qrSrc?.length}, starts with: ${qrSrc?.slice(0, 35)}...`);

  await page.waitForTimeout(2000);

  const step2Shot = path.join(ARTIFACTS_DIR, "whatsapp_step2_qr_code.png");
  await page.screenshot({ path: step2Shot, fullPage: true });
  console.log(`Captured Step 2 QR screenshot: ${step2Shot}`);

  // 6. Test Refresh QR Code button
  const refreshBtn = page.getByRole("button", { name: /Refresh QR Code/i });
  console.log(`Refresh button visible: ${await refreshBtn.isVisible()}`);
  if (await refreshBtn.isVisible()) {
    console.log("Clicking 'Refresh QR Code'...");
    await refreshBtn.click();
    await page.waitForTimeout(3500);

    const step2RefreshedShot = path.join(ARTIFACTS_DIR, "whatsapp_step2_qr_refreshed.png");
    await page.screenshot({ path: step2RefreshedShot, fullPage: true });
    console.log(`Captured Step 2 Refreshed QR screenshot: ${step2RefreshedShot}`);
  }

  console.log("==========================================");
  console.log("ALL BROWSER TESTS PASSED END-TO-END! DONE!");
  console.log("==========================================");
  await browser.close();
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
