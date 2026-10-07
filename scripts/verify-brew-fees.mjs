// 离线回归：Brew（brewfamily.dev）池子税徽章。
// 后台读取器用 2026-10-07 从 BSC 实录的 eth_call 结果回放（scripts/fixtures/brew-fee-rpc.json），
// 四类工厂（标准 / 分红币 / 多池 V1 / 多池 V2）各一个真实代币，外加一个非 Brew 币。
// 徽章渲染在真实浏览器里检查文字、配色、悬停说明、点击跳转、分项开关和战壕税标替换。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (n) => fs.readFileSync(path.join(root, n), 'utf8').replace(/\r\n/g, '\n');
const background = read('background.js');
const content = read('content.js');
const fixture = JSON.parse(read('scripts/fixtures/brew-fee-rpc.json')).calls;
// 按函数自身缩进找结尾：background.js 在顶层，content.js 缩进两格。
const fn = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const head = source.lastIndexOf('\n', start) + 1;
  const indent = source.slice(head, start).match(/^\s*/)[0];
  const end = source.indexOf(`\n${indent}}\n`, start);
  return source.slice(head, end + indent.length + 3).trimStart();
};
const between = (source, a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
let checks = 0;

const SAMPLES = {
  standard: '0x1bfa2c4fd710738eca79f9293ad7f213b0c76666',
  dividend: '0x3a05fe8ec34db0d7a669512d0d02ef3478376666',
  multiV1: '0xa6ff96ccccbeb761fd2399a440047ce8bd266666',
  multiV2: '0xab7317e3903860e308109126943e6b1d2e616666',
  notBrew: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
};

/** 每个用例一个全新上下文：缓存、熔断、队列都从零开始。 */
function reader({ calls = fixture, fail = false, hold = null } = {}) {
  const stats = { batches: 0 };
  const fakeFetch = async (_url, init) => {
    stats.batches += 1;
    if (hold) await hold;
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    const body = JSON.parse(init.body);
    const out = body.map((c) => {
      const key = `${c.params[0].to.toLowerCase()}|${c.params[0].data}`;
      return key in calls ? { jsonrpc: '2.0', id: c.id, result: calls[key] }
        : { jsonrpc: '2.0', id: c.id, error: { message: 'not recorded: ' + key.slice(0, 60) } };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  const ctx = vm.createContext({ fetch: fakeFetch, setTimeout, BigInt, Number, String, Map, Promise, TextDecoder, Uint8Array, Date });
  vm.runInContext([
    "const FLAP_RPCS = ['https://rpc.invalid/a', 'https://rpc.invalid/b'];",
    'const FLAP_SYMBOL_CACHE_MAX = 600; const flapSymbolCache = new Map();',
    fn(background, 'setBoundedMap'), fn(background, 'flapWords'),
    "const flapNum = (word) => (word ? Number(BigInt('0x' + word)) : 0);",
    fn(background, 'flapString'), "const flapAddr = (word) => (word ? '0x' + word.slice(24) : '');",
    fn(background, 'flapRpc'),
    between(background, 'const BREW_DISTRIBUTOR_FACTORY', 'let geniusFeeReader;'),
    'globalThis.brewTokenInfo = brewTokenInfo;',
  ].join('\n'), ctx);
  return { info: (token) => ctx.brewTokenInfo({ token }), stats };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

// ---- 四类工厂 + 非 Brew，结论与链上一致 ----
{
  const r = reader();
  const pick = (x) => ({ brewKind: x.brewKind, layout: x.layout, fee: x.fee, protocolBps: x.protocolBps,
    creatorBps: x.creatorBps, mode: x.mode, quoteSymbols: x.quoteSymbols });
  assert.deepEqual(plain(pick(await r.info(SAMPLES.standard))), {
    brewKind: 'standard', layout: 'standard', fee: 10000, protocolBps: 5000, creatorBps: 5000,
    mode: 'burn', quoteSymbols: ['BNCB'] }, '标准币：接收方 = predict 预测的分配器 → 回购销毁');
  assert.deepEqual(plain(pick(await r.info(SAMPLES.dividend))), {
    brewKind: 'dividend', layout: 'dividend', fee: 10000, protocolBps: 5000, creatorBps: 5000,
    mode: 'dividend', quoteSymbols: ['WBNB'] }, '分红币：接收方 = 分红跟踪器 → 分给持有人');
  assert.deepEqual(plain(pick(await r.info(SAMPLES.multiV1))), {
    brewKind: 'multipair', layout: 'multipair-v1', fee: 10000, protocolBps: 5000, creatorBps: 5000,
    mode: 'creator', quoteSymbols: ['WBNB', 'BREW'] }, '多池 V1：接收方是创作者');
  assert.deepEqual(plain(pick(await r.info(SAMPLES.multiV2))), {
    brewKind: 'multipair', layout: 'multipair-v2', fee: 10000, protocolBps: 5000, creatorBps: 5000,
    mode: 'creator', quoteSymbols: ['WBNB', 'USDC', 'USDT'] }, '多池 V2：接收方是创作者');
  assert.deepEqual(plain(await r.info(SAMPLES.notBrew)), { ok: false, reason: 'not-brew' });
  // 分配器还没部署（地址上没有合约代码），判定只能靠 predict 的预测地址
  const std = await r.info(SAMPLES.standard);
  assert.equal(std.recipient, std.distributor);
  assert.equal(std.distributor, '0x9532cbee6e9af3fa5c49c8a8fec3d7c77abd31fd');
  checks++;

  // 缓存：再查一遍不发请求；否定结论同样缓存
  const before = r.stats.batches;
  await r.info(SAMPLES.dividend);
  await r.info(SAMPLES.notBrew);
  assert.equal(r.stats.batches, before, '成功与 not-brew 都命中缓存');
  checks++;
}

// ---- 节点全挂：返回 rpc-failed、不缓存、熔断期间不再打节点 ----
{
  const r = reader({ fail: true });
  assert.equal((await r.info(SAMPLES.standard)).reason, 'rpc-failed');
  const after = r.stats.batches;
  assert.equal(after, 2, '两个节点各试一次');
  assert.equal((await r.info(SAMPLES.dividend)).reason, 'rpc-cooldown');
  assert.equal(r.stats.batches, after, '熔断期间不发请求');
  checks++;
}

// ---- 锁仓仓位不属于这个币：拒绝出结论（与官方前端同样的校验）----
{
  const tampered = { ...fixture };
  const key = Object.keys(tampered).find((k) => k.startsWith('0x3366e32702d6116b4fd2cd3353de2d5ff993f0d4|0x01a5e163'));
  tampered[key] = '0x' + '0'.repeat(24) + 'dead'.repeat(10) + tampered[key].slice(66);
  const r = reader({ calls: tampered });
  assert.equal((await r.info(SAMPLES.standard)).reason, 'brew-position-mismatch');
  checks++;
}

// ---- 排队上限：同时涌进来太多币时直接回 busy，不无限堆积 ----
{
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const r = reader({ hold });
  const tokens = Array.from({ length: 41 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
  const pending = tokens.slice(0, 40).map((t) => r.info(t));
  assert.equal((await r.info(tokens[40])).reason, 'busy');
  release();
  await Promise.all(pending);
  checks++;
}

// ---- 徽章渲染（真实浏览器）----
const names = ['flapMode', 'flapSegPct', 'flapBadgeText', 'flapTooltipText', 'flapTaxUrl', 'geniusBadgeText',
  'geniusTooltipText', 'brewTokenUrl', 'brewBadgeText', 'brewTooltipText', 'flapBadgeEnabled', 'restoreFlapNative',
  'ensureFlapBadge'];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setContent('<!doctype html><body><div id="host"></div><div id="trench"><div class="tax-wrapper"><div class="trenches-tax-badge"><span>Tax 1%</span></div></div></div></body>');
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    window.opened = [];
    window.open = (url) => { window.opened.push(url); };
    const FLAP_ADDR_RE = /^0x[a-fA-F0-9]{36}(7777|8888)$/;
    const settings = { enableFlapTaxBadge: true, enableGeniusBadge: true, enableBrewFeeBadge: true, priorityStrategyLanguageV1: 'en' };
    const flapInfoCache = new Map();
    ${between(content, '  const flapPct = ', '\n').trim()}
    ${between(content, '  const flapShort = ', '\n').trim()}
    ${between(content, '  const BREW_MODES = {', '  };') + '  };'}
    ${between(content, '  const brewFeePct = ', '\n').trim()}
    ${names.map((n) => fn(content, n)).join('\n')}
    window.t = { settings, flapInfoCache, ensureFlapBadge, flapBadgeEnabled };
  ` });
  const base = { ok: true, kind: 'brew', brewKind: 'standard', fee: 10000, protocolBps: 5000, creatorBps: 5000,
    recipient: '0x9532cbee6e9af3fa5c49c8a8fec3d7c77abd31fd', distributor: '0x9532cbee6e9af3fa5c49c8a8fec3d7c77abd31fd',
    tracker: '0x9f6133a58136e84f5ecfac229c6b015424ca7a02', quoteSymbols: ['BNCB'] };
  const render = (info, lang = 'en') => page.evaluate(({ info, lang, token }) => {
    t.settings.priorityStrategyLanguageV1 = lang;
    t.flapInfoCache.set(token, info);
    const host = document.getElementById('host');
    host.replaceChildren();
    t.ensureFlapBadge(host, token, null);
    const b = host.querySelector('.gdh-flap');
    return b && { text: b.textContent, cls: b.className, kind: b.dataset.gdhFeeKind, title: b.title };
  }, { info, lang, token: SAMPLES.standard });

  const burn = await render({ ...base, mode: 'burn' });
  assert.equal(burn.text, '🍺1% | 🔥50%');
  assert.equal(burn.cls, 'gdh-flap is-burn');
  assert.equal(burn.kind, 'brew');
  assert.match(burn.title, /Holder rewards: buyback & burn/);
  assert.match(burn.title, /Pool fee 1%/);
  assert.match(burn.title, /Protocol 50%/);
  assert.match(burn.title, /Distributor 0x9532…31fd/);
  const zh = await render({ ...base, mode: 'burn' }, 'zh');
  assert.match(zh.title, /回购本币并销毁/);
  assert.match(zh.title, /计价 BNCB/);
  const dividend = await render({ ...base, brewKind: 'dividend', mode: 'dividend', quoteSymbols: ['WBNB'] });
  assert.equal(dividend.text, '🍺1% | 💎50%');
  assert.equal(dividend.cls, 'gdh-flap is-holder');
  assert.match(dividend.title, /Dividend tracker 0x9f61…7a02/);
  const creator = await render({ ...base, brewKind: 'multipair', mode: 'creator', recipient: '0x57f62847ce6a61ff6a7afed9b08d2ba1f5e67034', quoteSymbols: ['WBNB', 'BREW'] });
  assert.equal(creator.text, '🍺1% | 👨‍🍳50%');
  assert.equal(creator.cls, 'gdh-flap is-creator');
  assert.match(creator.title, /Multi-pair/);
  assert.match(creator.title, /Quote WBNB \/ BREW/);
  // 费率档不是 1% 时照实显示，不写死
  const quarter = await render({ ...base, mode: 'burn', fee: 2500 });
  assert.equal(quarter.text, '🍺0.25% | 🔥50%');
  checks++;

  // 点击打开 Brew 代币页，且不把点击冒泡给 GMGN 的卡片链接
  const click = await page.evaluate(() => {
    const b = document.querySelector('#host .gdh-flap');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    b.dispatchEvent(ev);
    return { opened: window.opened.slice(-1)[0], prevented: ev.defaultPrevented };
  });
  assert.deepEqual(click, { opened: 'https://brewfamily.dev/token/?address=' + SAMPLES.standard, prevented: true });
  checks++;

  // 分项开关：只关 Brew 不影响 Flap / Genius
  const toggles = await page.evaluate((token) => {
    t.flapInfoCache.set(token, { ok: true, kind: 'brew', mode: 'burn' });
    t.flapInfoCache.set('flap', { ok: true, kind: 'flap' });
    t.flapInfoCache.set('genius', { ok: true, kind: 'genius' });
    const read = () => [token, 'flap', 'genius'].map((k) => t.flapBadgeEnabled(k));
    const on = read();
    t.settings.enableBrewFeeBadge = false;
    const off = read();
    t.settings.enableBrewFeeBadge = true;
    return { on, off };
  }, SAMPLES.standard);
  assert.deepEqual(toggles, { on: [true, true, true], off: [false, true, true] });
  checks++;

  // 战壕：GMGN 把 Brew 池费显示成 Tax 1%，徽章顶替这个原生税标（徽章里已带费率，信息不丢）
  const trench = await page.evaluate((info) => {
    t.flapInfoCache.set('trench', info);
    const native = document.querySelector('.trenches-tax-badge');
    const host = native.parentElement;
    t.ensureFlapBadge(host, 'trench', native);
    return { hidden: native.hasAttribute('data-gdh-flap-native'), display: getComputedStyle(native).display,
      badge: host.querySelector('.gdh-flap')?.textContent };
  }, { ...base, mode: 'burn' });
  assert.deepEqual(trench, { hidden: true, display: 'none', badge: '🍺1% | 🔥50%' });
  checks++;

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

// ---- 设置页与默认值 ----
const popupHtml = read('popup.html');
const popupJs = read('popup.js');
assert.match(content, /enableBrewFeeBadge: true/);
assert.match(popupJs, /enableBrewFeeBadge: true/);
assert.ok(popupJs.includes("enableBrewFeeBadge: document.querySelector('#enable-brew-fee-badge')"));
assert.match(popupHtml, /id="enable-brew-fee-badge"/);
checks++;

console.log(`PASS ${checks} Brew pool-fee badge checks (offline, recorded BSC data)`);
