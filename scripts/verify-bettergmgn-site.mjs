import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const site = read('site/index.html');
const fallbackVersion = site.match(/id="release-version">v(\d+\.\d+\.\d+)</)?.[1];
assert.ok(fallbackVersion, 'versioned static download fallback is required');
const popup = read('popup.html');
const manifest = JSON.parse(read('manifest.json'));
const sync = read('scripts/sync-bgm-download.py');
const nginx = read('site/nginx-bettergmgn.conf');
assert.equal(manifest.homepage_url, 'https://bettergmgn.com/');
assert.match(popup, /class="gdh-howto-link" href="https:\/\/bettergmgn\.com\/#features"/);
assert.match(popup, /id="updater-setup" href="https:\/\/bettergmgn\.com\/"/);
assert.ok(!popup.includes('985monitor.xyz/bgm/'));
assert.match(site, /rel="canonical" href="https:\/\/bettergmgn\.com\/"/);
assert.ok(site.includes('id="features"'));
assert.ok(sync.includes('/opt/bettergmgn/web/dl/'));
assert.ok(sync.includes('/opt/bettergmgn/backups/'));
assert.ok(sync.includes('recv_exit_status()'));
assert.ok(!sync.includes('xargs -r rm'));
assert.ok(!sync.includes('/opt/x-monitor-widget/web/bgm'));
assert.ok(nginx.includes('root /opt/bettergmgn/web;'));
assert.ok(nginx.includes('location / { return 404; }'));
assert.ok(!nginx.includes('proxy_pass'));
assert.ok(read('background.js').includes("const MONITOR985_ORIGIN = 'https://www.985monitor.xyz'"));
assert.ok(read('popup.js').includes("const DEFAULT_RELEASE_URL = 'https://github.com/0xuezhang985/985gmgn-helper/releases/latest'"));
console.log('PASS homepage, installer, publication path and unchanged API boundary');

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const valid of [true, false]) {
    const page = await browser.newPage();
    const requests = [];
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      requests.push(url.href);
      if (url.origin !== 'https://bettergmgn.com') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: site });
      if (url.pathname === '/version.json') return route.fulfill({ json: {
        version: '0.46.99',
        exe: valid ? 'dl/985gmgn-helper-setup-v0.46.99.exe' : 'https://untrusted.invalid/bad.exe',
        zip: valid ? 'dl/985gmgn-helper-v0.46.99.zip' : '../bad.zip',
      } });
      return route.fulfill({ status: 404 });
    });
    await page.goto('https://bettergmgn.com/');
    await page.waitForLoadState('networkidle');
    const expected = valid ? '0.46.99' : fallbackVersion;
    assert.equal(await page.locator('#dl-exe').evaluate(el => el.href), `https://bettergmgn.com/dl/985gmgn-helper-setup-v${expected}.exe`);
    assert.equal(await page.locator('#dl-zip').evaluate(el => el.href), `https://bettergmgn.com/dl/985gmgn-helper-v${expected}.zip`);
    assert.ok(requests.some(url => url.startsWith('https://bettergmgn.com/version.json?')));
    assert.ok(!requests.some(url => url.includes('untrusted.invalid')));
    assert.ok((await page.locator('#ver').innerText()).includes(`v${expected}`));
    await page.close();
    console.log(`PASS root-domain downloads, ${valid ? 'valid' : 'rejected external'} version metadata`);
  }
} finally {
  await browser.close();
}
