import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
const fallbackVersion = html.match(/id="release-version">v(\d+\.\d+\.\d+)</)?.[1];
assert.ok(fallbackVersion);
const key = 'betterGmgnSiteLanguageV1';
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
assert.ok(!html.includes('navigator.language'), 'first visit must not infer browser language');
assert.ok(!html.includes('innerHTML'), 'translations must use text nodes');
assert.ok(!html.includes('永续'), 'no permanent-session promise');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
let passed = 0;
async function fixture(options = {}) {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', javaScriptEnabled: options.js !== false });
  if (options.stored) await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key, value: options.stored });
  if (options.blockStorage) await context.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error('storage unavailable'); };
    Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  let pendingVersion;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.origin !== 'https://bettergmgn.com') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/icon128.png') return route.fulfill({ contentType: 'image/png', body: fs.readFileSync(path.join(root, 'icons/icon128.png')) });
    if (url.pathname === '/version.json') {
      if (options.delayed) { pendingVersion = route; return; }
      if (options.failVersion) return route.fulfill({ status: 503 });
      return route.fulfill({ json: { version: '0.46.99', exe: 'dl/985gmgn-helper-setup-v0.46.99.exe', zip: 'dl/985gmgn-helper-v0.46.99.zip' } });
    }
    return route.fulfill({ status: 404 });
  });
  await page.goto('https://bettergmgn.com/#features');
  return { context, page, requests, errors, pending: () => pendingVersion };
}
const value = (page, selector) => page.locator(selector).textContent();
const language = page => page.locator('html').getAttribute('lang');
const downloads = page => page.locator('.dl a').evaluateAll(elements => elements.map(el => el.href));
function pass(name) { passed++; console.log(`PASS ${name}`); }
try {
  const { context, page, requests, errors } = await fixture();
  assert.equal(await language(page), 'en');
  assert.equal(await value(page, '#dl-exe'), 'Download for Windows (.exe)');
  assert.match(await page.title(), /Wallet tracking/);
  assert.equal(await page.locator('[data-language="en"]').getAttribute('aria-pressed'), 'true');
  pass('English first visit even with a Chinese browser locale');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(root, 'dist/site-bilingual-en.png') });
  const originalDownloads = await downloads(page);
  const originalHash = new URL(page.url()).hash;
  const originalEnglish = await page.locator('[data-zh]').allTextContents();
  await page.locator('#faq details').first().evaluate(el => { el.open = true; });
  const countBefore = requests.filter(url => url.includes('/version.json?')).length;
  await page.locator('[data-language="zh"]').click();
  assert.equal(await language(page), 'zh-CN');
  assert.match(await page.title(), /聚合监控/);
  assert.equal(await value(page, '#dl-exe'), '下载 Windows 安装器 (.exe)');
  assert.match(await value(page, '#ver'), /最新版本.*v0\.46\.99/);
  assert.equal(await page.locator('meta[name="description"]').getAttribute('content'), '把 FOMO / Pump 动态融入 GMGN 和 DeBot，提供聚合监控、策略提醒、相似币浮窗、持仓信息与底池费率徽章。');
  assert.equal(await page.locator('[data-zh]').evaluateAll(elements => elements.every(el => el.textContent === el.dataset.zh)), true);
  assert.equal(await page.locator('#faq details').first().evaluate(el => el.open), true);
  assert.equal(new URL(page.url()).hash, originalHash);
  assert.deepEqual(await downloads(page), originalDownloads);
  assert.equal(requests.filter(url => url.includes('/version.json?')).length, countBefore);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'zh');
  await page.screenshot({ path: path.join(root, 'dist/site-bilingual-zh.png') });
  pass('complete Chinese translation; controls, expanded FAQ, URLs and downloads preserved');
  await page.reload();
  assert.equal(await language(page), 'zh-CN');
  await page.locator('[data-language="en"]').focus();
  await page.keyboard.press('Enter');
  assert.equal(await language(page), 'en');
  assert.deepEqual(await page.locator('[data-zh]').allTextContents(), originalEnglish);
  await page.reload();
  assert.equal(await language(page), 'en');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  pass('both language choices persist; keyboard switching and desktop layout work');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'dist/site-bilingual-features.png') });
  await context.close();

  for (const options of [{ blockStorage: true }, { stored: 'fr' }, { failVersion: true }]) {
    const f = await fixture(options);
    assert.equal(await language(f.page), 'en');
    await f.page.locator('[data-language="zh"]').click();
    assert.equal(await language(f.page), 'zh-CN');
    const expectedVersion = options.failVersion ? fallbackVersion : '0.46.99';
    assert.ok((await value(f.page, '#ver')).includes(`最新版本 v${expectedVersion}`));
    assert.deepEqual(await downloads(f.page), originalDownloads.map(url => url.replace('v0.46.99', `v${expectedVersion}`)));
    assert.deepEqual(f.errors, []);
    await f.context.close();
    pass(`safe fallback: ${Object.keys(options)[0]}`);
  }
  const delayed = await fixture({ delayed: true });
  await delayed.page.locator('[data-language="zh"]').click();
  await delayed.pending().fulfill({ json: { version: '9.8.7', exe: 'dl/985gmgn-helper-setup-v9.8.7.exe', zip: 'dl/985gmgn-helper-v9.8.7.zip' } });
  await delayed.page.waitForFunction(() => document.querySelector('#release-version').textContent === 'v9.8.7');
  assert.match(await value(delayed.page, '#ver'), /最新版本.*v9\.8\.7/);
  await delayed.page.locator('[data-language="en"]').click();
  assert.match(await value(delayed.page, '#ver'), /Latest release.*v9\.8\.7/);
  assert.ok((await downloads(delayed.page)).every(url => url.includes('v9.8.7')));
  assert.deepEqual(delayed.errors, []);
  await delayed.context.close();
  pass('late version response preserves chosen language and updated download version');

  const invalid = await fixture({ delayed: true });
  await invalid.pending().fulfill({ json: { version: '9.8.7', exe: 'https://untrusted.invalid/bad.exe', zip: '../bad.zip' } });
  await invalid.page.waitForLoadState('networkidle');
  assert.equal(await value(invalid.page, '#release-version'), `v${fallbackVersion}`);
  assert.deepEqual(await downloads(invalid.page), originalDownloads.map(url => url.replace('v0.46.99', `v${fallbackVersion}`)));
  await invalid.context.close();
  pass('untrusted version metadata cannot alter links or displayed release');

  const noJs = await fixture({ js: false });
  assert.equal(await language(noJs.page), 'en');
  assert.equal(await noJs.page.locator('#features .feat').first().evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal(await noJs.page.locator('.language-switch').isVisible(), false);
  assert.deepEqual(await downloads(noJs.page), originalDownloads.map(url => url.replace('v0.46.99', `v${fallbackVersion}`)));
  await noJs.context.close();
  pass('no-JavaScript page remains readable with working fallback download links');
  console.log(`${passed} bilingual site checks passed`);
} finally {
  await browser.close();
}
