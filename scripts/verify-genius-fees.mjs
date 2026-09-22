// Offline ABI / cache / rendering regression. No user wallet or strategy state is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = n => fs.readFileSync(path.join(root, n), 'utf8').replace(/\r\n/g, '\n');
const fees = require('../genius-fees.js');
const token = '0x8ac7d3db240c308e2e0a30fb9771fde92e0b5e59';
const other = '0x' + '2'.repeat(40), vault = '0x' + '3'.repeat(40);
const abi = xs => '0x' + xs.map(x => BigInt(x).toString(16).padStart(64, '0')).join('');
const record = (exists = 1, address = token) => abi([address, other, other, other, vault, 0, 0, 200, 0, 1, 0, 0, 0, 0, exists]);
const policy = (creator = 25, foundation = 1) => abi([100, 50, creator, 25, vault, foundation]);
const sample = { ok: true, kind: 'genius', token, ...fees.parseLaunch(record(), token), ...fees.parsePolicy(policy()) };
let checks = 0;
assert.equal(sample.totalBps, 200);
assert.equal(sample.creatorPayoutBps, 25);
assert.equal(sample.warning, false);
assert.equal(fees.parsePolicy(policy(26)).warning, true);
assert.equal(fees.parsePolicy(policy(0)).warning, false);
assert.equal(fees.parsePolicy(policy(25, 0)).creatorPayoutBps, 125);
assert.equal(fees.parsePolicy(policy(25, 0)).warning, true);
for (const raw of ['0x', '0xzz', abi([0, 0, 0, 0, vault, 1]), abi([100, 50, 25, 25, 0, 1]), abi([100, 50, 25, 25, vault, 2]), abi([10000, 10000, 1, 1, vault, 1])]) {
  assert.throws(() => fees.parsePolicy(raw));
}
assert.equal(fees.parseLaunch(record(0), token), null);
assert.throws(() => fees.parseLaunch(record(1, other), token));
assert.throws(() => fees.parseLaunch(record().slice(0, -2), token));
checks++;

let clock = 10000, calls = [], active = 0, maxActive = 0, fail = false, registered = true;
const reader = fees.createReader({ rpcUrls: ['https://test.invalid'], now: () => clock,
  sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
    active++; maxActive = Math.max(maxActive, active);
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(options.credentials, 'omit'); assert.equal(body.method, 'eth_call');
    assert.equal(body.params[0].to, fees.FACTORY);
    await Promise.resolve(); active--;
    if (fail) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ id: 1, result: body.params[0].data.startsWith(fees.SELECTORS.launch) ? record(+registered) : policy() }) };
  } });
const [a, b] = await Promise.all([reader.get(token), reader.get(token.toUpperCase())]);
assert.deepEqual(a, b); assert.equal(calls.length, 2); assert.equal(maxActive, 1);
await reader.get(token); assert.equal(calls.length, 2);
assert.equal((await reader.get('bad')).reason, 'bad-token'); assert.equal(calls.length, 2);
clock += 300001; fail = true;
assert.equal((await reader.get(token)).ok, false, 'expired success cannot be reused as a checkmark');
const failedCount = calls.length;
clock += 31000; await reader.get(token); assert.equal(calls.length, failedCount, '429 cooldown shared across tokens');
clock += 300001; fail = false;
assert.equal((await reader.get(token)).ok, true, 'transient failures recover');
registered = false;
assert.equal((await reader.get(other)).reason, 'not-genius');
const negativeCount = calls.length; await reader.get(other); assert.equal(calls.length, negativeCount);
checks++;

// Queue is bounded and independently serialized across different token requests.
let queueClock = 10000, queueActive = 0, peak = 0;
const queueReader = fees.createReader({ rpcUrls: ['https://test.invalid'], now: () => queueClock,
  sleep: async ms => { queueClock += ms; }, fetchImpl: async () => {
    queueActive++; peak = Math.max(peak, queueActive); await Promise.resolve(); queueActive--;
    return { ok: true, json: async () => ({ id: 1, result: record(0) }) };
  } });
const queued = await Promise.all(Array.from({ length: 70 }, (_, n) => queueReader.get('0x' + (n + 1).toString(16).padStart(40, '0'))));
assert.equal(peak, 1); assert.equal(queued.filter(x => x.reason === 'busy').length, 6); checks++;

// Flap routing remains available; Genius failures are never reinterpreted as a non-Genius token.
const background = read('background.js');
const router = background.slice(background.indexOf('let geniusFeeReader;'), background.indexOf('// 代币总供应量（人类可读口径'));
let flapCalls = 0, geniusCalls = 0, response = sample;
const context = vm.createContext({ FLAP_RPCS: [], GDHGeniusFees: { createReader: () => ({ get: async () => { geniusCalls++; return response; } }) },
  flapTokenInfo: async () => { flapCalls++; return { ok: true, kind: 'flap' }; } });
vm.runInContext(router, context);
assert.equal((await context.tokenFeeInfo({ token })).kind, 'genius'); assert.equal(flapCalls, 0);
response = { ok: false, reason: 'not-genius' };
assert.equal((await context.tokenFeeInfo({ token })).kind, 'flap');
response = { ok: false, reason: 'rpc-failed' };
assert.equal((await context.tokenFeeInfo({ token })).reason, 'rpc-failed'); assert.equal(flapCalls, 1);
assert.equal((await context.tokenFeeInfo({ token: '0x' + '1'.repeat(36) + '7777' })).kind, 'flap');
assert.equal(geniusCalls, 3); checks++;

const source = read('content.js');
const names = ['chipText', 'findNativeTaxChip', 'isColumnFlow', 'tokenMetaOwnRow', 'flapOwnRow', 'restoreFlapNative', 'clearFlapCard',
  'flapTrenchOwnRow', 'clearFlapBadges', 'tokenDetailBadgeRow', 'geniusTrenchLink', 'geniusTrenchOwnRow', 'flapTaxUrl', 'geniusBadgeText', 'geniusTooltipText', 'flapBadgeEnabled', 'ensureFlapBadge', 'scanFlapBadges',
  'markedHoldingSummary', 'holdingShareText', 'ensureMarkedBadge', 'renderTokenMarkedBadge'];
const extract = name => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
for (const kind of ['flap', 'genius']) {
  const cached = { ok: true, kind, fetchedAt: 1 };
  const cache = new Map([[token, cached]]);
  let finished;
  const settled = new Promise(resolve => { finished = resolve; });
  const requestContext = vm.createContext({ Date, settings: {}, flapPending: new Set(), flapInfoCache: cache,
    flapRetry: new Map(), FLAP_SUCCESS_TTL: 300000, FLAP_RETRY_BASE: 8000, FLAP_RETRY_MAX: 5, FLAP_CACHE_MAX: 400,
    chrome: { runtime: { sendMessage: async () => ({ ok: false, reason: 'rpc-failed' }) } },
    setBoundedMap: (map, key, value) => map.set(key, value), scheduleScan: finished });
  vm.runInContext(extract('requestFlapInfo'), requestContext);
  requestContext.requestFlapInfo(token); await settled;
  assert.equal(cache.get(token).ok, kind === 'flap', 'only Genius checkmarks must disappear on refresh failure');
}
checks++;
{
  let completed, requests = 0;
  const settled = new Promise(resolve => { completed = resolve; });
  const cache = new Map([[token, { ok: false, reason: 'rpc-failed' }]]);
  const retry = new Map([[token, { at: Date.now() - 300001, tries: 5 }]]);
  const ctx = vm.createContext({ Date, settings: {}, flapPending: new Set(), flapInfoCache: cache,
    flapRetry: retry, FLAP_SUCCESS_TTL: 300000, FLAP_RETRY_BASE: 8000, FLAP_RETRY_MAX: 5, FLAP_CACHE_MAX: 400,
    chrome: { runtime: { sendMessage: async () => { requests++; return sample; } } },
    setBoundedMap: (map, key, value) => map.set(key, value), scheduleScan: completed });
  vm.runInContext(extract('requestFlapInfo'), ctx);
  ctx.requestFlapInfo(token); await settled;
  assert.equal(requests, 1); assert.equal(cache.get(token).ok, true); assert.equal(retry.has(token), false);
  checks++;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/*', r => r.abort());
  await page.setContent(read('scripts/fixtures/trench-tax-layout.html'));
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    const CARD_SELECTOR = '[data-testid="trench-token-card"]';
    const FLAP_ADDR_RE = /^0x[a-fA-F0-9]{36}(7777|8888)$/;
    const settings = { enableFlapTax: true, priorityStrategyLanguageV1: 'en' };
    const flapInfoCache = new Map(), requested = new Set(), markedMap = new Map();
    const fomoUsd = usd => '$' + usd;
    const flapPct = bps => (bps / 100) + '%';
    let chain = 'bsc', route = null;
    function currentChain() { return chain; }
    function currentTokenRoute() { return route; }
    function searchScopes() { return [...document.querySelectorAll('#search')]; }
    function requestFlapInfo(t) { requested.add(t); }
    function flapMode() { return { cls: 'holder', name: 'Flap' }; }
    function flapBadgeText() { return 'Tax 3%'; }
    function flapTooltipText() { return 'Flap details'; }
    ${names.map(extract).join('\n')}
    const sample = ${JSON.stringify(sample)}, token = sample.token;
    const card = document.querySelector(CARD_SELECTOR);
    card.setAttribute('href', '/bsc/token/' + token);
    const baseline = card.getBoundingClientRect().toJSON();
    const metrics = card.querySelector('.metrics').getBoundingClientRect().toJSON();
    flapInfoCache.set(token, sample); scanFlapBadges();
  ` });
  const initial = await page.evaluate(() => ({ text: card.querySelector('.gdh-flap').textContent, title: card.querySelector('.gdh-flap').title,
    sameHeight: card.getBoundingClientRect().height === baseline.height,
    sameMetrics: JSON.stringify(card.querySelector('.metrics').getBoundingClientRect().toJSON()) === JSON.stringify(metrics),
    inSlot: card.querySelector('.gdh-flap-row').parentElement.classList.contains('tax-wrapper') }));
  assert.equal(initial.text, '✓'); assert.match(initial.title, /Total trading fee: 2%/);
  assert.equal(await page.locator('[data-gdh-flap-native]').count(), 0, 'compact Genius badge preserves native tax');
  assert.match(initial.title, /Foundation accumulation: 1%/); assert.match(initial.title, /Genius platform: 0.5%/);
  assert.match(initial.title, /not a token safety rating/);
  assert.ok(initial.sameHeight && initial.sameMetrics && initial.inSlot); checks++;
  const mutations = await page.evaluate(async () => {
    let count = 0; const observer = new MutationObserver(ms => { count += ms.length; });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    scanFlapBadges(); scanFlapBadges(); await Promise.resolve(); observer.disconnect(); return count;
  });
  assert.equal(mutations, 0, 'stable scans do not mutate DOM'); checks++;
  const warn = await page.evaluate(() => {
    flapInfoCache.set(token, { ...sample, toFoundation: false, creatorPayoutBps: 125 }); scanFlapBadges();
    const b = card.querySelector('.gdh-flap'); return { text: b.textContent, cls: b.className, title: b.title };
  });
  assert.equal(warn.text, '⚠'); assert.match(warn.cls, /genius-warning/);
  assert.doesNotMatch(warn.title, /Foundation accumulation/); checks++;
  await page.evaluate(() => {
    const center = document.createElement('div'); center.id = 'detail';
    center.style.cssText = 'height:400px;display:flex;flex-direction:column';
    center.innerHTML = '<div data-sentry-component="BaseInfoBar" style="height:70px;flex-shrink:0;display:flex"><div>Genius token</div><div class="text-[20px]">$12K</div></div><div id="chart" style="flex:1;min-height:0">Chart</div>';
    document.body.appendChild(center);
    route = { chain: 'bsc', address: token }; scanFlapBadges();
    // 真实 GMGN 搜索结果行：整行横向 flex，指标列宽度写死，税标是「图标 + 文字」
    // 且图标字体往 textContent 里塞了一个私用区码点（实测 ）。
    const search = document.createElement('div'); search.id = 'search';
    search.innerHTML = '<a href="/bsc/token/' + token + '" style="display:flex;align-items:center;height:72px;width:766px">'
      + '<div style="min-width:0;overflow:hidden;padding:6px 2px 6px 8px;flex:3.5">'
      + '<div style="display:flex;align-items:center"><div style="display:flex;align-items:center">'
      + '<div style="width:52px;height:52px"></div>'
      + '<div style="display:flex;align-items:center;margin-left:8px"><div style="display:flex;flex-direction:column">'
      + '<div style="display:flex;height:16px;align-items:center;gap:4px">SEARCH</div>'
      + '<div style="display:flex;height:16px;min-width:0;align-items:center;gap:4px;overflow:hidden;white-space:nowrap">'
      + '<div style="display:inline-flex"><span style="display:flex;height:16px;flex-shrink:0;align-items:center;gap:2px">'
      + '<svg viewBox="0 0 16 16" style="width:12px"></svg>Tax 2%</span></div>'
      + '</div></div></div></div></div></div>'
      + '<div id="search-mc" style="margin-left:8px;display:flex;width:88px;flex-direction:column">MC $12K</div>'
      + '<div id="search-v" style="margin-left:8px;display:flex;width:88px;flex-direction:column">V $0</div>'
      + '</a>';
    document.body.appendChild(search);
    // 只比横向几何与行高：纵向位置会被上面详情页徽章那一行整体推走，与本断言无关。
    window.searchBox = s => { const r = document.querySelector(s).getBoundingClientRect(); return Math.round(r.left) + '/' + Math.round(r.width); };
    window.searchBefore = ['#search-mc', '#search-v'].map(window.searchBox);
    window.searchHeightBefore = Math.round(document.querySelector('#search a').getBoundingClientRect().height);
    scanFlapBadges();
  });
  assert.equal(await page.locator('.gdh-flap').count(), 3);
  // 搜索结果：徽章必须另起一行落在名称列里，不能把写死宽度的指标列顶跑。
  assert.deepEqual(await page.evaluate(() => {
    const link = document.querySelector('#search a'), name = link.children[0];
    const row = link.querySelector('.gdh-flap-row'), r = row.getBoundingClientRect(), n = name.getBoundingClientRect();
    return {
      columnsMoved: ['#search-mc', '#search-v'].map(window.searchBox).some((now, i) => now !== window.searchBefore[i]),
      badgeInsideName: r.left >= n.left && r.right <= n.right,
      rowIsDirectFlexChild: row.parentElement === link,
      nativeTaxHidden: !!link.querySelector('[data-gdh-flap-native]'),
      rowGrew: Math.round(link.getBoundingClientRect().height) > window.searchHeightBefore,
    };
  }), { columnsMoved: false, badgeInsideName: true, rowIsDirectFlexChild: false, nativeTaxHidden: false, rowGrew: false },
  'search badge takes its own line inside the name column and keeps the native tax chip');
  checks++;
  assert.equal(await page.evaluate(() => {
    const bar = document.querySelector('[data-sentry-component="BaseInfoBar"]'), row = document.querySelector('.gdh-flap-row--detail');
    return row.parentElement.previousElementSibling === bar && row.getBoundingClientRect().height < 35
      && document.querySelector('#chart').getBoundingClientRect().height > 280;
  }), true, 'real GMGN header anchor, not market cap; chart retains remaining height');
  await page.evaluate(() => {
    markedMap.set(token, [{ name: 'Fixture', amount: 20, supply: 1000, usd: 123 }]);
    renderTokenMarkedBadge(); scanFlapBadges();
  });
  assert.equal(await page.locator('.gdh-token-detail-badges > .gdh-token-marked-badges .gdh-marked').count(), 1);
  assert.match(await page.locator('.gdh-token-marked-badges').innerText(), /2%/);
  assert.equal(await page.evaluate(() => {
    const fee = document.querySelector('.gdh-flap-row--detail').getBoundingClientRect();
    const marked = document.querySelector('.gdh-token-marked-badges').getBoundingClientRect();
    return Math.abs((fee.y + fee.height / 2) - (marked.y + marked.height / 2)) < 1 && marked.x > fee.right;
  }), true, 'marked holdings and fee badge are aligned on one row');
  await page.evaluate(() => { settings.enableFlapTax = false; renderTokenMarkedBadge(); scanFlapBadges(); });
  assert.equal(await page.locator('.gdh-token-marked-badges .gdh-marked').count(), 1, 'fee switch must not remove marked holdings');
  await page.evaluate(() => { settings.enableFlapTax = true; settings.enableMarkedHolders = false; renderTokenMarkedBadge(); scanFlapBadges(); });
  assert.equal(await page.locator('.gdh-flap-row--detail .gdh-flap').count(), 1);
  assert.equal(await page.locator('.gdh-token-marked-badges').count(), 0);
  await page.evaluate(() => { settings.enableMarkedHolders = true; renderTokenMarkedBadge(); });
  checks++;
  const recycle = await page.evaluate(() => {
    route.address = '0x' + '4'.repeat(40);
    card.setAttribute('href', '/bsc/token/' + route.address);
    document.querySelector('#search a').setAttribute('href', '/eth/token/' + token);
    renderTokenMarkedBadge(); scanFlapBadges(); return { badges: document.querySelectorAll('.gdh-flap').length, hidden: document.querySelectorAll('[data-gdh-flap-native]').length };
  });
  assert.deepEqual(recycle, { badges: 0, hidden: 0 }); checks++;
  assert.equal(await page.locator('.gdh-token-marked-badges').count(), 0, 'route change clears marked holdings');
  await page.evaluate(() => {
    card.setAttribute('href', '/bsc/token/' + token); route.address = token;
    flapInfoCache.set(token, sample); scanFlapBadges();
    window.opened = []; window.open = url => { opened.push(url); };
    card.querySelector('.gdh-flap').click();
    settings.priorityStrategyLanguageV1 = 'zh'; scanFlapBadges();
  });
  assert.deepEqual(await page.evaluate(() => opened), ['https://genius.fun/token/' + token]);
  assert.match(await page.locator('.gdh-flap').first().getAttribute('title'), /总交易费率/); checks++;
  await page.evaluate(() => {
    window.tax = card.querySelector('.trenches-tax-badge'); tax.remove();
    const icon = document.createElement('a'); icon.href = 'https://genius.fun/token/' + token;
    icon.className = 'platform'; icon.style.cssText = 'position:absolute;left:70px;top:55px;width:14px;height:14px';
    card.appendChild(icon); scanFlapBadges();
  });
  assert.equal(await page.locator('.platform > .gdh-flap-row--genius-icon .gdh-flap').innerText(), '✓');
  await page.evaluate(() => { card.querySelector('.tax-wrapper').appendChild(tax); scanFlapBadges(); });
  assert.equal(await page.locator('.gdh-flap-row--genius-icon').count(), 0, 'tax slot arrival moves existing icon without duplicates');
  assert.equal(await page.locator('[data-testid="trench-token-card"] .gdh-flap').count(), 1);
  checks++;
  await page.evaluate(() => { flapInfoCache.set(token, { ok: false, reason: 'rpc-failed' }); scanFlapBadges(); });
  assert.equal(await page.locator('.gdh-flap').count(), 0);
  assert.equal(await page.locator('[data-gdh-flap-native]').count(), 0); checks++;
  await page.evaluate(() => {
    flapInfoCache.set(token, sample); scanFlapBadges(); settings.enableFlapTax = false; scanFlapBadges();
  });
  assert.equal(await page.locator('.gdh-flap-row').count(), 0);
  await page.evaluate(() => { settings.enableFlapTax = true; chain = 'eth'; scanFlapBadges(); });
  assert.equal(await page.locator('.gdh-flap').count(), 0); checks++;
  await page.evaluate(() => { chain = 'bsc'; scanFlapBadges(); });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  await page.evaluate(() => { renderTokenMarkedBadge(); });
  await page.screenshot({ path: path.join(root, 'dist/genius-badge-v99.png') });
} finally { await browser.close(); }
assert.match(read('scripts/build-release.ps1'), /'genius-fees.js'/);
assert.match(background, /importScripts\([^;]*'genius-fees.js'/);
console.log(`PASS ${checks} Genius ABI/cache/routing/DOM checks (offline)`);
