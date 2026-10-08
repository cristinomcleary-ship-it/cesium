// Verify the packaged artifact after build-platform-v5-delivery.py; no project Viewer or business writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/胡航/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'output/platform-v5'), dir = path.join(out, 'delivery');
const report = { scope: 'Packaged local gallery, source/evidence hashes, actual image decode and five playable recordings; no new engineering acceptance claim.', checks: [], errors: [], videos: [] };
let browser;
(async () => {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest-sha256.json'), 'utf8'));
    for (const [name, expected] of Object.entries(manifest)) {
      const file = path.resolve(dir, name); assert.ok(file.startsWith(dir + path.sep));
      const bytes = await fs.readFile(file);
      assert.equal(bytes.length, expected.bytes, name);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, name);
    }
    report.checks.push(`${Object.keys(manifest).length} artifact file sizes and SHA-256 hashes match`);
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto('http://127.0.0.1:5173/output/platform-v5/delivery/index.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { for (const img of document.images) img.loading = 'eager'; });
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 120000 });
    report.images = await page.locator('img').count(); assert.ok(report.images >= 50);
    report.checks.push('All packaged screenshot images decode in the actual gallery');
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('G13') && text.includes('G14') && text.includes('未全部完成'));
    await page.locator('#compare-range').fill('65');
    assert.ok((await page.locator('#front').evaluate(e => getComputedStyle(e).clipPath)).includes('35%'));
    report.checks.push('Same-camera comparison slider responds; G13/G14 limitations remain explicit');
    const videos = page.locator('video'); assert.equal(await videos.count(), 5);
    for (let i = 0; i < 5; i++) {
      const video = videos.nth(i); await video.scrollIntoViewIfNeeded();
      await video.evaluate(async v => { v.muted = true; await v.play(); });
      await page.waitForTimeout(800);
      const metadata = await video.evaluate(v => ({ src: v.currentSrc, duration: v.duration, width: v.videoWidth, height: v.videoHeight, time: v.currentTime, error: v.error?.message }));
      assert.ok(metadata.duration > 20 && metadata.width === 1920 && metadata.height === 1080 && metadata.time > .1 && !metadata.error);
      await video.evaluate(v => { v.currentTime = v.duration * .53; });
      await page.waitForTimeout(800);
      const seeked = await video.evaluate(v => ({ time: v.currentTime, duration: v.duration, seeking: v.seeking, error: v.error?.message }));
      assert.ok(!seeked.seeking && !seeked.error && seeked.time >= seeked.duration * .53);
      await video.evaluate(v => v.pause()); report.videos.push({ ...metadata, seeked });
    }
    report.checks.push('Five actual H.264 recordings play and seek successfully');
    await page.goto('http://127.0.0.1:5173/output/platform-v5/delivery/docs/acceptance.html', { waitUntil: 'domcontentloaded' });
    assert.ok((await page.locator('body').innerText()).includes('G14'));
    assert.deepEqual(report.errors, []); report.result = 'passed';
  } catch (error) { report.result = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1; }
  finally { await browser?.close(); await fs.writeFile(path.join(out, 'delivery-validation.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
})();
