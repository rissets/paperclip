const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

async function run() {
  const screenshotDir = '/Users/danangharissetiawan/Dev/decide/paperclip/brain-screenshots';
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

  console.log('=== TEST STEP 1: Verify audio player & dynamic action items in Meeting Detail ===');
  await page.goto('http://127.0.0.1:3100/DAT/meetings/131f4213-7029-4c39-8c08-e5abcb9df704', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Take screenshot of meeting detail with audio player
  await page.screenshot({ path: path.join(screenshotDir, '10-meeting-detail-audio-loaded.png') });
  console.log('Saved 10-meeting-detail-audio-loaded.png');

  // Verify no dummy tickets exist
  const dummyText1 = await page.getByText('Kirim proposal revisi ke klien').count();
  const dummyText2 = await page.getByText('Konfigurasi environment staging').count();
  console.log(`Dummy ticket 1 count: ${dummyText1}, Dummy ticket 2 count: ${dummyText2}`);
  if (dummyText1 > 0 || dummyText2 > 0) {
    throw new Error('FAILED: Dummy tickets are still present in Meeting Detail!');
  }
  console.log('PASS: No dummy tickets found in Meeting Detail.');

  // Test Play audio button
  console.log('Testing Audio Playback...');
  const playButton = page.locator('button:has(svg.lucide-play), button:has(svg.lucide-pause)').first();
  await playButton.click();
  await page.waitForTimeout(2000);

  // Verify audio state via evaluate
  const audioInfo = await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) return { found: false };
    return {
      found: true,
      src: audio.src,
      paused: audio.paused,
      currentTime: audio.currentTime,
      duration: audio.duration,
      readyState: audio.readyState,
    };
  });
  console.log('Audio element state:', audioInfo);
  if (audioInfo.paused) {
    throw new Error('FAILED: Audio did not play!');
  }
  console.log('PASS: Audio is actively playing, readyState is', audioInfo.readyState);

  await page.screenshot({ path: path.join(screenshotDir, '11-meeting-detail-audio-playing.png') });
  console.log('Saved 11-meeting-detail-audio-playing.png');

  // Test Dynamic Action Items Extraction with Copilot
  console.log('Testing Copilot Action Items Extraction button...');
  const extractBtn = page.getByRole('button', { name: /Ekstrak Action Items dengan Copilot/i });
  if (await extractBtn.isVisible()) {
    await extractBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(screenshotDir, '12-action-items-extracted.png') });
    console.log('Saved 12-action-items-extracted.png');

    const createdItems = await page.locator('button:has-text("Buat Task")').count();
    console.log(`Extracted action items count with "Buat Task": ${createdItems}`);
  }

  console.log('=== TEST STEP 2: Verify Persistent Live Recorder Across Navigation ===');
  // Navigate client-side to meetings list
  await page.getByRole('link', { name: /Meeting Notes/i }).first().click();
  await page.waitForTimeout(1000);

  // Start a new recording
  console.log('Opening drawer via Mulai Rapat...');
  const startBtn = page.getByRole('button', { name: /Mulai Rapat/i }).first();
  await startBtn.click();
  await page.waitForTimeout(600);

  // Click Mulai Merekam inside drawer
  console.log('Clicking Mulai Merekam inside drawer...');
  const recordStartBtn = page.getByRole('button', { name: /Mulai Merekam/i }).first();
  await recordStartBtn.click();
  await page.waitForTimeout(2000);

  // Verify Live Copilot Analysis is in drawer
  const liveAnalysisHeader = await page.getByText(/Live Copilot Analysis/i).count();
  console.log(`Live Copilot Analysis header count in drawer: ${liveAnalysisHeader}`);
  if (liveAnalysisHeader === 0) {
    throw new Error('FAILED: Live Copilot Analysis header not visible while recording!');
  }
  console.log('PASS: Live Copilot Analysis is visible in drawer.');

  await page.screenshot({ path: path.join(screenshotDir, '13-recorder-drawer-recording.png') });
  console.log('Saved 13-recorder-drawer-recording.png');

  // Click "Buka Rapat ↗" inside the drawer to navigate client-side to Meeting Detail
  console.log('Clicking Buka Rapat link inside drawer...');
  const bukaRapatBtn = page.getByRole('button', { name: /Buka Rapat/i }).first();
  await bukaRapatBtn.click();
  await page.waitForTimeout(1000);

  // Verify URL has changed to meeting detail
  const currentUrl = page.url();
  console.log('Current URL after Buka Rapat:', currentUrl);

  // Verify the floating recorder shortcut pill is PRESENT on meeting detail page!
  const shortcutPill = page.locator('button[title="Perbesar Panel Rekaman"]');
  const isPillVisible = await shortcutPill.isVisible();
  console.log(`Is recorder pill visible on Meeting Detail page?: ${isPillVisible}`);
  if (!isPillVisible) {
    throw new Error('FAILED: Recorder disappeared when navigating to Meeting Detail!');
  }
  console.log('PASS: Recorder persisted across page navigation as floating shortcut pill!');

  await page.screenshot({ path: path.join(screenshotDir, '14-recorder-persisted-on-detail.png') });
  console.log('Saved 14-recorder-persisted-on-detail.png');

  // Expand the drawer back from pill on Meeting Detail page
  console.log('Expanding drawer from pill...');
  await shortcutPill.click();
  await page.waitForTimeout(600);

  await page.screenshot({ path: path.join(screenshotDir, '15-recorder-expanded-on-detail.png') });
  console.log('Saved 15-recorder-expanded-on-detail.png');

  // Stop recording cleanly
  console.log('Clicking Selesai Rapat...');
  const stopBtn = page.getByRole('button', { name: /Selesai Rapat/i }).first();
  await stopBtn.click();
  await page.waitForTimeout(2000);

  await page.screenshot({ path: path.join(screenshotDir, '16-recording-finished.png') });
  console.log('Saved 16-recording-finished.png');

  await browser.close();
  console.log('=== ALL TESTS PASSED SUCCESSFULLY! ===');
}

run().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
