// Offline fixtures exercise production functions; never uses real login state or APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const content = read('content.js'), background = read('background.js'), audit = read('scripts/verify-audit-fixes.mjs');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const functions = (...names) => names.map(n => extract(content, n)).join('\n');
const maps = ['FOMO_NETWORK_ID', 'FOMO_CHAIN_SLUG', 'FOMO_GMGN_CHAIN'].map(n => content.match(new RegExp(`const ${n} = [^;]+;`))[0]).join('\n');
const address = '0x' + '1'.repeat(40);
let checks = 0; const pass = text => console.log(`PASS ${++checks}: ${text}`);
const route = vm.createContext({ location: { pathname: '' } });
vm.runInContext(maps + functions('currentTokenRoute'), route);
for (const [chain, id] of Object.entries({ arc: 5042, eth: 1, bsc: 56, sol: 1399811149, base: 8453, monad: 143, robinhood: 4663 })) {
  route.location.pathname = `/${chain}/token/${address}`;
  assert.equal(route.currentTokenRoute().networkId, id);
  assert.equal(vm.runInContext(`FOMO_GMGN_CHAIN[${id}]`, route), chain);
}
assert.equal(vm.runInContext('FOMO_CHAIN_SLUG.arc', route), 'arc');
for (const pathname of ['/arc/address/' + address, '/unknown/token/' + address, '/']) {
  route.location.pathname = pathname; assert.equal(route.currentTokenRoute(), null);
}
pass('GMGN Arc 识别为 FOMO 5042，双向映射正确，已有链及非代币页不回归');

const requests = [], queued = [];
const api = vm.createContext({ URL, Date, Response, Map, Number, JSON, encodeURIComponent,
  FOMO_API: 'https://prod-api.fomo.family', FOMO_CACHE_MS: 120000, FOMO_CACHE_MAX: 100,
  fomoCache: new Map(), fomoTokenPending: new Map(),
  fomoQueuedFetch: fn => { queued.push(true); return fn(); },
  chrome: { storage: { local: { get: async () => ({ fomoToken: { token: 'offline-fixture', exp: Date.now() + 600000 } }) } } },
  fetch: async (url, opts) => {
    requests.push({ url, opts });
    return new Response(JSON.stringify({ success: true, statusCode: 200, responseObject: [{
      totalHolders: 103, topHolders: [{ humanAmount: 250, value: 50, user: { username: 'fixture' } }],
    }] }));
  },
  setBoundedMap: (map, key, value) => map.set(key, value),
});
vm.runInContext([
  background.match(/const FOMO_CHAINS = [^;]+;/)[0],
  extract(background, 'fomoBodyUnauthed'), extract(background, 'fomoResponseUnauthed'),
  background.slice(background.indexOf('async function fomoAuthedFetch('), background.indexOf('// ---- 单个用户的 7 天盈亏')),
].join('\n'), api);
const args = { tokenAddress: address, networkId: 5042, kind: 'holders' };
const [a, b] = await Promise.all([api.fomoFetchTokenShared(args), api.fomoFetchTokenShared(args)]);
assert.equal(a.ok, true); assert.equal(a.total, 103); assert.equal(a.items[0].humanAmount, 250); assert.equal(a, b);
assert.equal(requests.length, 1); assert.equal(queued.length, 1);
const url = new URL(requests[0].url);
assert.equal(url.pathname, '/hodlers/top');
assert.deepEqual(JSON.parse(url.searchParams.get('tokens')), [{ address, networkId: 5042 }]);
assert.ok(requests[0].opts.headers['X-Supported-Chains'].split(',').includes('5042'));
assert.equal(requests[0].opts.credentials, 'include');
await api.fomoFetchTokenShared(args); assert.equal(requests.length, 1);
await api.fomoFetchTokenShared({ ...args, networkId: 1 }); assert.equal(requests.length, 2);
pass('Arc 持仓使用正确 API 参数及链头，复用本地认证、队列和缓存，跨链同地址不串数据');

let resolve;
const calls = [];
const stats = vm.createContext({ Date, Number, settings: {}, FOMO_REFRESH_MS: 120000,
  fomoStats: { key: '', holders: null, updatedAt: 0 }, fomoHeaderRequest: {}, fomoLoading: false, fomoTab: 'thesis', fomoSelfHealTried: false,
  chrome: { runtime: { sendMessage: async msg => { calls.push(msg); return new Promise(r => { resolve = r; }); } } },
  loadFomoSupply() {}, renderFomoStats() {}, renderTokenHeaderBadges() {},
});
vm.runInContext(functions('loadFomoHeaderStats'), stats);
const arc = { chain: 'arc', address, networkId: 5042 };
let pending = stats.loadFomoHeaderStats(arc);
assert.equal(calls[0].payload.networkId, 5042);
resolve({ ok: true, items: a.items, total: a.total }); await pending;
assert.equal(stats.fomoStats.holders.total, 103);
await stats.loadFomoHeaderStats(arc); assert.equal(calls.length, 1);
stats.settings.enableFomoPanel = false;
await stats.loadFomoHeaderStats({ ...arc, address: '0x' + '2'.repeat(40) }); assert.equal(calls.length, 1);
stats.settings.enableFomoPanel = true; stats.fomoStats.updatedAt = 0; stats.fomoHeaderRequest.at = 0;
pending = stats.loadFomoHeaderStats(arc);
stats.fomoStats = { key: `eth|${address}`, holders: null, supply: 0 };
resolve({ ok: true, items: a.items, total: a.total }); await pending;
assert.equal(stats.fomoStats.holders, null);
pass('表头自动取 Arc 持仓，遵守总开关和两分钟缓存，旧链响应不会覆盖新代币');

let supplyRequest;
const supply = vm.createContext({ Number, JSON, settings: {}, fomoSupplyLoadingKey: '',
  fomoStats: { key: `arc|${address}`, supply: 0 }, gmgnApiQuery: () => 'fixture=1',
  fetch: async (url, opts) => { supplyRequest = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ code: 0, data: [{ total_supply: '1000' }] }) }; },
  chrome: { runtime: { sendMessage: () => { throw new Error('unexpected background supply request'); } } },
  renderFomoStats() {}, renderTokenHeaderBadges() {},
});
vm.runInContext(functions('loadFomoSupply'), supply);
await supply.loadFomoSupply(arc);
assert.deepEqual(supplyRequest.body, { chain: 'arc', addresses: [address] }); assert.equal(supply.fomoStats.supply, 1000);
pass('Arc 持仓比例复用 GMGN 同源供应量接口，不把其他链供应量混入');

const compact = vm.runInNewContext(extract(background, 'compactFomoTrendingItems') + ';compactFomoTrendingItems');
const items = compact([{ token: { networkId: 5042, address, symbol: 'ARC', name: 'Fixture' }, marketCap: 1000 }]);
assert.equal(items.length, 1); assert.equal(items[0].chain, 'arc');
pass('同一 FOMO 链映射用于热门列表，Arc 条目不再被当作未知链丢弃');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<main id="header"><div><div><div><span id="token-base-symbol" data-symbol="ARC">ARC</span></div></div></div><div><span><span id="token-base-address" data-addr="fixture">address</span></span></div></main>' }));
  await page.goto(`https://gmgn.ai/arc/token/${address}`);
  await page.addScriptTag({ content: maps + `
    let settings = { enableMarkedHolders: false, fomoPanelOpen: false };
    let fomoStats = { key: 'arc|${address}', holders: { items: [{ humanAmount: 250, value: 50 }], total: 103 }, supply: 1000 };
    const fomoUsd = n => '$' + n;
    function setFomoOpen(open) { settings.fomoPanelOpen = open; }
    function scheduleScan() {}
    let notificationPanelOpen = false, notificationPanelEl = null;
    function deepPick() { return null; }
    ${functions('currentTokenRoute', 'holderTokenAmount', 'fomoHoldingSummary', 'holdingShareText', 'tokenHeaderBlock', 'renderTokenHeaderBadges', 'ensureFomoLauncher')}
    ensureFomoLauncher(); renderTokenHeaderBadges();
  ` });
  assert.equal(await page.locator('.gdh-fomo-launcher').count(), 1);
  assert.equal(await page.locator('.gdh-token-header-fomo').textContent(), 'fomo ≥25%');
  assert.match(await page.locator('.gdh-token-header-fomo').getAttribute('title'), /1\/103/);
  await page.evaluate(() => { settings.enableFomoPanel = false; ensureFomoLauncher(); renderTokenHeaderBadges(); });
  assert.equal(await page.locator('.gdh-fomo-launcher').count(), 0);
  assert.equal(await page.locator('.gdh-token-header-fomo').count(), 0);
  pass('Arc 页面实际 DOM 出现 FOMO 入口与占比徽章，仅前排持仓标 ≥，关闭功能会移除');
} finally { await browser.close(); }
console.log(`FOMO Arc holdings: ${checks} checks passed`);
