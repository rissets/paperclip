const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

async function run() {
  const screenshotDir = '/Users/danangharissetiawan/.gemini/antigravity/brain/5a0eff06-539a-48e7-805f-58fefeb35dee/screenshots';
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
  });

  await context.addCookies([
    {
      name: 'paperclip-default.session_token',
      value: '61d5b22fd1c1a049715ea7e213389897eca65b51248bb420f6d1dc5e5584a4eb',
      domain: '127.0.0.1',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: 'paperclip-default.session_token',
      value: '61d5b22fd1c1a049715ea7e213389897eca65b51248bb420f6d1dc5e5584a4eb',
      domain: 'localhost',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }
  ]);

  const page = await context.newPage();

  console.log('1. Navigating to meetings page...');
  await page.goto('http://127.0.0.1:3100/DAT/meetings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Click Mulai Rapat Baru
  console.log('2. Clicking Mulai Rapat Baru...');
  const startMeetingBtn = page.getByRole('button', { name: /Mulai Rapat/i }).first();
  await startMeetingBtn.click();
  await page.waitForTimeout(800);

  // Enter Title
  const titleInput = page.locator('input[placeholder*="Weekly Sprint Sync"], input[placeholder*="Judul Rapat"]').first();
  if (await titleInput.isVisible()) {
    await titleInput.fill('Live End-to-End Verification Meeting');
    console.log('Filled title');
  }

  // Click Mulai Merekam
  console.log('3. Clicking Mulai Merekam inside drawer...');
  const recordStartBtn = page.getByRole('button', { name: /Mulai Merekam/i }).first();
  await recordStartBtn.click();
  await page.waitForTimeout(1000);

  // Stream live chunks for 12 seconds
  console.log('4. Streaming live audio for 12 seconds...');
  for (let s = 1; s <= 12; s++) {
    await page.waitForTimeout(1000);
    process.stdout.write(`... ${s}s\n`);
  }

  await page.screenshot({ path: path.join(screenshotDir, '29-live-recorder-active.png') });
  console.log('Saved 29-live-recorder-active.png');

  // Stop recording
  console.log('5. Clicking Selesai Rapat...');
  const stopBtn = page.getByRole('button', { name: /Selesai Rapat/i }).first();
  await stopBtn.click();
  await page.waitForTimeout(4000);

  await page.screenshot({ path: path.join(screenshotDir, '30-after-recording-finished.png') });
  console.log('Saved 30-after-recording-finished.png');

  // Check URL
  console.log('Current URL after save:', page.url());

  await browser.close();
  console.log('Done end-to-end test.');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
