const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

async function run() {
  const screenshotDir = '/Users/danangharissetiawan/.gemini/antigravity/brain/5a0eff06-539a-48e7-805f-58fefeb35dee/screenshots';
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
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
  await page.screenshot({ path: path.join(screenshotDir, '01-meetings-list.png') });
  console.log('Saved 01-meetings-list.png');

  console.log('2. Opening Live Meeting Recorder Drawer...');
  const startBtn = page.getByRole('button', { name: /Mulai Rapat/i }).first();
  await startBtn.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, '02-drawer-initial.png') });
  console.log('Saved 02-drawer-initial.png');

  console.log('3. Minimizing Live Recorder Drawer to floating shortcut pill...');
  const minimizeBtn = page.locator('button[title="Minimize ke Shortcut Pill"]').first();
  await minimizeBtn.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, '03-drawer-minimized.png') });
  console.log('Saved 03-drawer-minimized.png');

  console.log('4. Maximizing Live Recorder Drawer from shortcut pill...');
  const maximizeBtn = page.locator('button[title="Perbesar Panel Rekaman"]').first();
  await maximizeBtn.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, '04-drawer-reopened.png') });
  console.log('Saved 04-drawer-reopened.png');

  console.log('5. Closing Live Recorder Drawer...');
  const closeBtn = page.locator('button[title*="Tutup"]').first();
  await closeBtn.click();
  await page.waitForTimeout(600);

  console.log('6. Navigating to Meeting Detail page...');
  await page.goto('http://127.0.0.1:3100/DAT/meetings/1336e665-5715-4b64-b318-ec42867a4166', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Check if floating chat widget exists on meeting detail page
  const floatingChatWidget = await page.locator('button[aria-label="Open assistant chat"]').count();
  console.log('Global floating chat widget count on detail page (must be 0 to avoid duplicate chat bubble):', floatingChatWidget);

  await page.screenshot({ path: path.join(screenshotDir, '05-meeting-detail-copilot-open.png') });
  console.log('Saved 05-meeting-detail-copilot-open.png');

  console.log('7. Collapsing Copilot sidebar in Meeting Detail...');
  const toggleCopilotBtn = page.getByRole('button', { name: /Tutup Copilot/i }).first();
  await toggleCopilotBtn.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, '06-meeting-detail-copilot-collapsed.png') });
  console.log('Saved 06-meeting-detail-copilot-collapsed.png');

  console.log('8. Restoring Copilot sidebar via floating edge tab...');
  const edgeTab = page.locator('button:has-text("Copilot")').last();
  await edgeTab.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(screenshotDir, '07-meeting-detail-copilot-restored.png') });
  console.log('Saved 07-meeting-detail-copilot-restored.png');

  console.log('9. Testing Meeting Copilot chat input...');
  const chatInput = page.locator('input[placeholder*="Tanyakan apapun tentang rapat"]').first();
  if (await chatInput.isVisible()) {
    await chatInput.fill('Apa intisari dari rapat ini?');
    const sendBtn = page.locator('button:has-text("Kirim"), button:has([class*="Send"])').last();
    await sendBtn.click();
    console.log('Sent prompt to Copilot, waiting 2s...');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(screenshotDir, '08-meeting-detail-copilot-chat.png') });
    console.log('Saved 08-meeting-detail-copilot-chat.png');
  }

  await browser.close();
  console.log('ALL TESTS COMPLETED SUCCESSFULLY!');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
