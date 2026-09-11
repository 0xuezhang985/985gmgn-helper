// Offline Chromium regression. Set PLAYWRIGHT_MODULE to a local playwright module if needed.
// node scripts/verify-trench-tax-layout.mjs [--baseline]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseline = process.argv.includes('--baseline');
const read = (name) => (baseline
  ? execFileSync('git', ['show', `v0.46.64:${name}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n');
const source = read('content.js');
const names = ['findNativeTaxChip', 'tokenMetaOwnRow', 'flapOwnRow', 'restoreFlapNative',
  'clearFlapCard', 'flapTrenchOwnRow', 'clearFlapBadges', 'ensureFlapBadge', 'scanFlapBadges'];
const functions = names.filter((name) => source.includes(`function ${name}(`)).map((name) => {
  const start = source.indexOf(`  function ${name}(`);
  // All selected top-level functions terminate with exactly two spaces + closing brace.
  const end = source.indexOf('\n  }', start) + 4;
  assert.ok(end > start, `missing ${name}`);
  return source.slice(start, end);
}).join('\n');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/*', (route) => route.abort());
  await page.setContent(fs.readFileSync(path.join(root, 'scripts/fixtures/trench-tax-layout.html'), 'utf8'));
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    const CARD_SELECTOR = '[data-testid="trench-token-card"]';
    const FLAP_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
    const settings = { enableFlapTax: true };
    const flapInfoCache = new Map();
    function currentChain() { return 'bsc'; }
    function currentTokenRoute() { return null; }
    function searchScopes() { return []; }
    function requestFlapInfo() {}
    function flapMode() { return { cls: 'holder', name: 'Holder dividend' }; }
    function flapBadgeText() { return 'Tax 3% 💎100%→SPCXB 🪙SPCXB'; }
    function flapTooltipText() { return 'Full tax allocation and pool details'; }
    function flapTaxUrl() { return ''; }
    ${functions}
    window.card = document.querySelector(CARD_SELECTOR);
    window.token = card.getAttribute('href').split('/').pop();
    window.mount = () => { flapInfoCache.set(token, { ok: true, dist: {} }); scanFlapBadges(); };
    window.measure = () => {
      const row = card.querySelector('.gdh-flap-row');
      const badge = row?.querySelector('.gdh-flap');
      const rect = (el) => el?.getBoundingClientRect().toJSON();
      return { card: rect(card), row: rect(row), badge: rect(badge), tax: rect(card.querySelector('.trenches-token-base-stacked-row')),
        metrics: rect(card.querySelector('.metrics')), stats: rect(card.querySelector('.stats')),
        rows: card.querySelectorAll('.gdh-flap-row').length,
        nativeHidden: getComputedStyle(card.querySelector('.trenches-tax-badge') || card.querySelector('.legacy-tax')).display === 'none',
        room: card.dataset.gdhFlapRoom || '', inSlot: row?.parentElement.classList.contains('tax-wrapper') || false };
    };
  ` });
  const initial = await page.evaluate(() => measure());
  await page.evaluate(() => mount());
  const first = await page.evaluate(() => measure());
  if (baseline) {
    assert.ok(first.card.height !== initial.card.height || !first.inSlot);
    console.log(JSON.stringify({ baseline: 'old layout defect reproduced', before: initial.card.height, after: first.card.height, inTaxSlot: first.inSlot }));
  } else {
    for (const width of [280, 360, 520, 967]) {
      const { raw, metrics } = await page.evaluate((width) => {
        document.querySelector('#list').style.width = width + 'px'; clearFlapCard(card);
        const raw = measure(); scanFlapBadges(); return { raw, metrics: measure() };
      }, width);
      assert.equal(metrics.card.height, initial.card.height, `${width}: fixed virtual row height`);
      assert.equal(metrics.rows, 1);
      assert.equal(metrics.room, '');
      assert.ok(metrics.inSlot && metrics.nativeHidden);
      assert.equal(metrics.row.height, 16);
      assert.ok(metrics.badge.width <= 220 && metrics.badge.height <= 16);
      assert.ok(metrics.metrics.bottom <= metrics.card.bottom && metrics.stats.right <= metrics.card.right);
      assert.deepEqual(metrics.metrics, raw.metrics, `${width}: metrics must not move`);
      assert.deepEqual(metrics.stats, raw.stats, `${width}: market cap must not move`);
      checks++;
    }
    const mutationCount = await page.evaluate(async () => {
      let writes = 0; const observer = new MutationObserver((ms) => { writes += ms.length; });
      observer.observe(card, { subtree: true, attributes: true, childList: true, characterData: true });
      scanFlapBadges(); scanFlapBadges(); await Promise.resolve(); observer.disconnect(); return writes;
    });
    assert.equal(mutationCount, 0, 'stable scans must not rewrite DOM'); checks++;
    const rebuilt = await page.evaluate(() => {
      const chip = card.querySelector('.trenches-tax-badge'); const next = chip.cloneNode(true);
      next.removeAttribute('data-gdh-flap-native'); chip.replaceWith(next); scanFlapBadges(); return measure();
    });
    assert.ok(rebuilt.inSlot && rebuilt.nativeHidden && rebuilt.rows === 1); checks++;
    const pending = await page.evaluate(() => {
      token = '0x2222222222222222222222222222222222227777'; card.setAttribute('href', '/bsc/token/' + token);
      scanFlapBadges(); return { rows: card.querySelectorAll('.gdh-flap-row').length, hidden: card.querySelectorAll('[data-gdh-flap-native]').length };
    });
    assert.deepEqual(pending, { rows: 0, hidden: 0 }); checks++;
    const missing = await page.evaluate(() => {
      window.savedChip = card.querySelector('.trenches-tax-badge'); savedChip.remove(); mount();
      return card.querySelectorAll('.gdh-flap-row').length;
    });
    assert.equal(missing, 0, 'no fallback into card root'); checks++;
    const arrived = await page.evaluate(() => {
      card.querySelector('.tax-wrapper').appendChild(savedChip); scanFlapBadges(); return measure();
    });
    assert.ok(arrived.inSlot && arrived.nativeHidden && arrived.rows === 1); checks++;
    const moved = await page.evaluate(() => {
      const host = document.createElement('div'); host.className = 'tax-wrapper';
      card.querySelector('.title').appendChild(host); host.appendChild(savedChip); scanFlapBadges();
      return { aligned: savedChip.nextElementSibling?.classList.contains('gdh-flap-row'), slots: card.querySelectorAll('[data-gdh-flap-slot]').length, height: card.getBoundingClientRect().height };
    });
    assert.deepEqual(moved, { aligned: true, slots: 1, height: initial.card.height }); checks++;
    const legacy = await page.evaluate(() => {
      clearFlapCard(card); card.classList.add('legacy');
      savedChip.className = 'legacy-tax'; savedChip.textContent = 'Tax 3%';
      scanFlapBadges(); return measure();
    });
    assert.ok(legacy.inSlot && legacy.nativeHidden && legacy.rows === 1);
    assert.equal(legacy.card.height, initial.card.height); checks++;
    const disabled = await page.evaluate(() => {
      settings.enableFlapTax = false; scanFlapBadges();
      return { rows: card.querySelectorAll('.gdh-flap-row').length, hidden: card.querySelectorAll('[data-gdh-flap-native]').length, slots: card.querySelectorAll('[data-gdh-flap-slot]').length };
    });
    assert.deepEqual(disabled, { rows: 0, hidden: 0, slots: 0 }); checks++;
    console.log(`PASS ${checks} browser layout/lifecycle checks (offline, no API requests)`);
  }
} finally {
  await browser.close();
}
