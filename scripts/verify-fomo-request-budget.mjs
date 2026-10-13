// Offline fixtures exercise production functions; never touches real FOMO accounts or APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const background = read('background.js'), content = read('content.js'), debot = read('debot-content.js');
const popup = read('popup.js'), popupHtml = read('popup.html'), audit = read('scripts/verify-audit-fixes.mjs');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const constValue = (source, name) => vm.runInNewContext(source.match(new RegExp(`const ${name} = ([^;]+);`))[1]);
let checks = 0; const pass = text => console.log(`PASS ${++checks}: ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 1. 节流参数：间隔加抖动、每小时上限；用户选择保留原刷新间隔
assert.equal(constValue(background, 'FOMO_REQUEST_GAP_MS'), 3000);
assert.equal(constValue(background, 'FOMO_REQUEST_JITTER_MS'), 1500);
assert.equal(constValue(background, 'FOMO_HOURLY_BUDGET'), 240);
assert.equal(constValue(background, 'FOMO_BUDGET_WINDOW_MS'), 60 * 60 * 1000);
assert.equal(constValue(background, 'FOMO_PNL_TTL'), 60 * 60 * 1000);
assert.equal(constValue(content, 'FOMO_PNL_TTL'), 60 * 60 * 1000);
assert.equal(constValue(content, 'FOMO_PNL_TOP'), 10);
assert.equal(constValue(content, 'FOMO_REFRESH_MS'), 2 * 60 * 1000);
assert.equal(constValue(content, 'FOMO_TRENDING_REFRESH_MS'), 60 * 1000);
assert.equal(constValue(debot, 'PANEL_REFRESH_MS'), 2 * 60 * 1000);
assert.equal(constValue(background, 'FOMO_CACHE_MS'), 90 * 1000);
assert.equal(constValue(background, 'FOMO_TRENDING_CACHE_MS'), 60 * 1000);
pass('请求间隔 3 秒 + 0–1.5 秒抖动、每小时 240 次上限、7 天盈亏缓存 1 小时；占比/浮窗/热门榜刷新间隔保持原样');

// 2. 每小时上限：真实生产函数在 vm 里跑
const gateFns = ['fomoLoadRateLimit', 'fomoRetryAfterMs', 'fomoBackoffResponse', 'fomoLoadBudget',
  'fomoBudgetWaitMs', 'fomoBudgetResponse', 'fomoQueuedFetch'].map(n => extract(background, n)).join('\n');
function gate({ stored = {}, ...overrides } = {}) {
  const writes = [];
  const ctx = vm.createContext({
    Response, setTimeout, Date,
    FOMO_REQUEST_GAP_MS: 1, FOMO_REQUEST_JITTER_MS: 0, FOMO_429_BASE_MS: 60000, FOMO_429_MAX_MS: 1800000,
    FOMO_RATE_LIMIT_KEY: 'fomoRateLimitStateV1', FOMO_HOURLY_BUDGET: 3, FOMO_BUDGET_WINDOW_MS: 3600000,
    FOMO_BUDGET_KEY: 'fomoRequestBudgetV1',
    fomoRequestTail: Promise.resolve(), fomoNextRequestAt: 0, fomoRateLimitUntil: 0, fomoRateLimitLevel: 0,
    fomoRateLimitLastAt: 0, fomoRateLimitReady: null, fomoBudgetStamps: [], fomoBudgetReady: null,
    chrome: { storage: { local: {
      get: async () => JSON.parse(JSON.stringify(stored)),
      set: async (value) => { writes.push(JSON.parse(JSON.stringify(value))); },
    } } },
    ...overrides,
  });
  vm.runInContext(gateFns, ctx);
  return { ctx, writes };
}
{
  const { ctx, writes } = gate();
  let upstream = 0;
  const ok = () => { upstream += 1; return new Response('{}', { status: 200 }); };
  const first = await Promise.all([ctx.fomoQueuedFetch(ok), ctx.fomoQueuedFetch(ok), ctx.fomoQueuedFetch(ok)]);
  const fourth = await ctx.fomoQueuedFetch(ok);
  assert.deepEqual(first.map(r => r.status), [200, 200, 200]);
  assert.equal(upstream, 3, '超额请求不能打到 fomo');
  assert.equal(fourth.status, 429);
  assert.equal(fourth.headers.get('X-GDH-Fomo-Budget'), '1');
  assert.equal(fourth.headers.get('X-GDH-Fomo-Backoff'), null);
  const retry = Number(fourth.headers.get('Retry-After'));
  assert.ok(retry > 3500 && retry <= 3600, `Retry-After ${retry}`);
  assert.equal(writes.filter(w => 'fomoRequestBudgetV1' in w).length, 3);
  assert.deepEqual(writes.at(-1).fomoRequestBudgetV1.length, 3);
  assert.equal(ctx.fomoRateLimitLevel, 0, '自家额度用完不算 fomo 限流，不升级退避');
  assert.equal(writes.filter(w => 'fomoRateLimitStateV1' in w).length, 0);
  pass('每小时额度用完后直接返回本地 429（带 X-GDH-Fomo-Budget），不再访问 fomo，也不触发 fomo 限流退避');
}
{
  const { ctx } = gate({ FOMO_REQUEST_GAP_MS: 5000, FOMO_HOURLY_BUDGET: 1 });
  await ctx.fomoQueuedFetch(() => new Response('{}', { status: 200 }));
  const started = Date.now();
  const blocked = await ctx.fomoQueuedFetch(() => new Response('{}', { status: 200 }));
  assert.equal(blocked.headers.get('X-GDH-Fomo-Budget'), '1');
  assert.ok(Date.now() - started < 1000, `超额请求白等了 ${Date.now() - started}ms`);
  pass('超额请求立即返回，不白等 3 秒请求间隔');
}
{
  const now = Date.now();
  const stored = { fomoRequestBudgetV1: [now - 7200000, now - 3599700, now - 60000, now - 1000, now + 999999] };
  const { ctx } = gate({ stored });
  let upstream = 0;
  const ok = () => { upstream += 1; return new Response('{}', { status: 200 }); };
  const blocked = await ctx.fomoQueuedFetch(ok);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('X-GDH-Fomo-Budget'), '1');
  assert.equal(upstream, 0);
  await sleep(450);
  const allowed = await ctx.fomoQueuedFetch(ok);
  assert.equal(allowed.status, 200);
  assert.equal(upstream, 1);
  pass('额度时间戳从存储恢复（Service Worker 重启不清零），过期和未来时间戳被丢弃，最老一条滑出窗口后自动放行');
}
{
  const fakeMath = Object.assign(Object.create(Math), { random: () => 0.5 });
  const { ctx } = gate({ FOMO_REQUEST_GAP_MS: 3000, FOMO_REQUEST_JITTER_MS: 1000, FOMO_HOURLY_BUDGET: 240, Math: fakeMath });
  const before = Date.now();
  await ctx.fomoQueuedFetch(() => new Response('{}', { status: 200 }));
  const gap = ctx.fomoNextRequestAt - before;
  assert.ok(gap >= 3500 && gap <= 3600, `gap ${gap}`);
  pass('下一次请求时间 = 3 秒基础间隔 + 随机抖动');
}

// 3. 三类请求把额度用完映射成 budget-limited，真正的 fomo 429 仍是 rate-limited
const address = '0x' + '1'.repeat(40);
const budgetResponse = () => new Response('{"error":"budget_exhausted"}', { status: 429, headers: { 'Retry-After': '1235', 'X-GDH-Fomo-Budget': '1' } });
const fomo429 = () => new Response('', { status: 429 });
function apiContext(respond, extra = {}) {
  const ctx = vm.createContext({ URL, Date, Response, Map, Number, JSON, encodeURIComponent, String, Array, Math,
    FOMO_API: 'https://prod-api.fomo.family', FOMO_CACHE_MS: 90000, FOMO_CACHE_MAX: 60,
    fomoCache: new Map(), fomoTokenPending: new Map(), fomoRateLimitUntil: Date.now() + 600000,
    fomoBudgetWaitMs: () => 1234567,
    fomoQueuedFetch: async () => respond(),
    fomoRefreshSession: async () => null,
    chrome: { storage: { local: { get: async () => ({ fomoToken: { token: 'offline-fixture', exp: Date.now() + 600000 } }) } } },
    setBoundedMap: (map, key, value) => map.set(key, value),
    ...extra,
  });
  vm.runInContext([
    background.match(/const FOMO_CHAINS = [^;]+;/)[0],
    extract(background, 'fomoBodyUnauthed'), extract(background, 'fomoResponseUnauthed'),
    background.slice(background.indexOf('async function fomoAuthedFetch('), background.indexOf('// ---- 单个用户的 7 天盈亏')),
  ].join('\n'), ctx);
  return ctx;
}
{
  const budget = apiContext(budgetResponse);
  const r = await budget.fomoFetchToken({ tokenAddress: address, networkId: 56, kind: 'holders' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'budget-limited'); assert.equal(r.retryAfterMs, 1234567);
  assert.equal(budget.fomoCache.size, 0, '失败不进缓存');
  const limited = apiContext(fomo429);
  const l = await limited.fomoFetchToken({ tokenAddress: address, networkId: 56, kind: 'thesis' });
  assert.equal(l.reason, 'rate-limited'); assert.ok(l.retryAfterMs > 590000 && l.retryAfterMs <= 600000);

  const pnlCtx = vm.createContext({ Date, Response, Map, Number, JSON, encodeURIComponent, Array,
    FOMO_PNL_TTL: 3600000, FOMO_PNL_CACHE_MAX: 500, fomoPnlCache: new Map(), fomoRateLimitUntil: 0,
    fomoBudgetWaitMs: () => 7654321, setBoundedMap: (map, key, value) => map.set(key, value),
    fomoAuthedFetch: async () => ({ res: budgetResponse(), unauthed: false }),
  });
  // extractFunction 不认解构参数，按源码区段切出整个函数
  vm.runInContext(background.slice(background.indexOf('async function fomoUserPnl7d('), background.indexOf('// ---- Flap 代币税收信息')), pnlCtx);
  const p = await pnlCtx.fomoUserPnl7d({ userId: 'u1' });
  assert.equal(p.reason, 'budget-limited'); assert.equal(p.retryAfterMs, 7654321); assert.equal(pnlCtx.fomoPnlCache.size, 0);
  let pnlCalls = 0;
  pnlCtx.fomoAuthedFetch = async () => {
    pnlCalls += 1;
    return { res: new Response(JSON.stringify({ success: true, statusCode: 200, responseObject: [
      { snapshotId: 1, equity: 1000, pnl: 10 }, { snapshotId: 2, equity: 1200, pnl: 110 }] })), unauthed: false };
  };
  const first = await pnlCtx.fomoUserPnl7d({ userId: 'u2' });
  const second = await pnlCtx.fomoUserPnl7d({ userId: 'u2' });
  assert.equal(first.pnl, 100); assert.equal(second, first); assert.equal(pnlCalls, 1);

  const trendCtx = vm.createContext({ Date, Response, Number, JSON, String, Array,
    FOMO_TRENDING_CACHE_MS: 60000, fomoTrendingCache: null, fomoTrendingPending: null, fomoRateLimitUntil: 0,
    fomoBudgetWaitMs: () => 999000,
    fomoAuthedFetch: async () => ({ res: budgetResponse(), stored: { token: 'offline-fixture', at: 1 }, renewed: false, unauthed: false }),
  });
  vm.runInContext([extract(background, 'compactFomoTrendingItems'), extract(background, 'fomoFetchTrending')].join('\n'), trendCtx);
  const t = await trendCtx.fomoFetchTrending();
  assert.equal(t.reason, 'budget-limited'); assert.equal(t.retryAfterMs, 999000); assert.equal(trendCtx.fomoTrendingCache, null);
  pass('代币动态 / 7 天盈亏 / 热门榜在额度用完时都返回 budget-limited 与准确恢复时间，失败不缓存；fomo 自己的 429 仍是 rate-limited；7 天盈亏成功结果 1 小时内不重查');
}

// 4. 设置项与提示文案
assert.match(popupHtml, /<input id="enable-fomo-holder-pnl" type="checkbox" \/>/);
assert.ok(popup.includes('enableFomoHolderPnl: false,'));
assert.ok(popup.includes("enableFomoHolderPnl: document.querySelector('#enable-fomo-holder-pnl')"));
assert.ok(content.includes('enableFomoHolderPnl: false,'));
assert.ok(debot.includes('enableFomoHolderPnl: false,'));
assert.ok(content.includes("reason === 'budget-limited'"));
assert.ok(debot.includes("reason === 'budget-limited'"));
assert.ok(content.includes("fomoTrendingError === 'budget-limited'"));
pass('7 天盈亏开关在设置页、GMGN、DeBot 三处默认都是关；两边浮窗和热门榜都有「本小时已到上限」提示');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="host"></main>' }));
  await page.goto('https://gmgn.ai/bsc/token/fixture');

  // 5. 持仓者列表：默认不挂 7 天盈亏；打开后只给持仓金额最大的 10 人挂
  const holders = [5, 900, 30, 700, 1, 800, 60, 500, 40, 600, 20, 400, 10, 300, 200]
    .map((value, i) => ({ value, user: { id: `u${i}`, userHandle: `h${i}` } }));
  holders.push({ value: 99999, user: { userHandle: 'no-uid' } });
  const expectedTop = holders.filter(h => h.user.id).sort((a, b) => b.value - a.value).slice(0, 10).map(h => h.user.id).sort();
  const gmgnHolders = await page.evaluate(({ code, items }) => {
    const host = document.querySelector('#host');
    const run = new Function('items', 'host', `
      let settings = { mergeFomoHolders: false, enableFomoHolderPnl: false };
      const watched = [];
      function resetFomoTagObserver() {}
      function watchFomoTag(el, uid) { watched.push(uid); }
      function holderAvatar() { return ''; }
      function holderName(item) { return item.user.userHandle; }
      function attachFomoBoard() {}
      function buildRankBadge() { return null; }
      function holderTokenAmount() { return 0; }
      function fomoUser(item) { return item?.user; }
      function fomoDur() { return ''; }
      function deepPick() { return null; }
      const fomoUsd = (n) => '$' + n;
      function fomoPrice() { return ''; }
      function queueFomoTranslate() {}
      ${code}
      const list = document.createElement('div'); host.append(list);
      renderFomoHolders(list, items);
      const off = { rows: list.querySelectorAll('.gdh-fomo__hrow').length, tags: list.querySelectorAll('.gdh-fomo__tag').length, watched: watched.length };
      settings.enableFomoHolderPnl = true;
      renderFomoHolders(list, items);
      return { off, on: { tags: list.querySelectorAll('.gdh-fomo__tag').length, watched: [...watched].sort() } };
    `);
    return run(items, host);
  }, { code: [content.match(/const FOMO_PNL_TOP = \d+;/)[0], extract(content, 'fomoPnlTopUids'), extract(content, 'renderFomoHolders')].join('\n'), items: holders });
  assert.deepEqual(gmgnHolders.off, { rows: 16, tags: 0, watched: 0 });
  assert.equal(gmgnHolders.on.tags, 10);
  assert.deepEqual(gmgnHolders.on.watched, expectedTop);
  pass('GMGN 持仓者：默认零个 7 天盈亏请求；打开后只查持仓金额前 10（不依赖接口顺序，无 uid 的跳过）');

  const debotHolders = await page.evaluate(({ code, items }) => {
    const host = document.querySelector('#host');
    const run = new Function('items', 'host', `
      let settings = { enableFomoHolderPnl: false };
      let pnlObserver = null;
      const watched = [];
      function watchPnl(el, uid) { watched.push(String(uid)); }
      function panelHeader(item) { const h = document.createElement('div'); h.textContent = item.user.userHandle; return h; }
      function fomoUser(item) { return item?.user; }
      function deepPick() { return null; }
      const fomoUsd = (n) => '$' + n;
      function fomoPrice() { return ''; }
      function safeText(value) { return String(value || ''); }
      function translateText() {}
      ${code}
      const list = document.createElement('div'); host.append(list);
      renderHolders(list, items);
      const off = { rows: list.querySelectorAll('.gdh-debot-fomo__holder').length, tags: list.querySelectorAll('.gdh-debot-fomo__pnl-tag').length };
      settings.enableFomoHolderPnl = true;
      renderHolders(list, items);
      return { off, on: { tags: list.querySelectorAll('.gdh-debot-fomo__pnl-tag').length, watched: [...watched].sort() } };
    `);
    return run(items, host);
  }, { code: [extract(debot, 'fomoPnlTopUids'), extract(debot, 'renderHolders')].join('\n'), items: holders });
  assert.deepEqual(debotHolders.off, { rows: 16, tags: 0 });
  assert.equal(debotHolders.on.tags, 10);
  assert.deepEqual(debotHolders.on.watched, expectedTop);
  pass('DeBot 持仓者：同样默认关闭，打开后只查持仓金额前 10');

  // 6. 折叠态只拉持仓者；展开按当前页签
  const gmgnFold = await page.evaluate(({ code }) => {
    const run = new Function(`
      const calls = [], rendered = [];
      const chrome = { runtime: { sendMessage: async (msg) => { calls.push(msg.payload.kind); return { ok: true, items: [{ value: 5 }], total: 3 }; } }, storage: { local: { get: async () => ({}) } } };
      const route = { chain: 'bsc', address: '0xabc', networkId: 56 };
      function currentTokenRoute() { return route; }
      const fomoPanelEl = document.createElement('section'); fomoPanelEl.className = 'gdh-fomo-panel is-folded';
      const list = document.createElement('div'); list.className = 'gdh-fomo__list'; list.innerHTML = '<div class="old">old</div>';
      fomoPanelEl.append(list); document.body.append(fomoPanelEl);
      let fomoTab = 'thesis', fomoLoadedKey = '', fomoErrKey = '', fomoErrAt = 0, fomoLoading = false, fomoLastItems = ['keep'], fomoSelfHealTried = false;
      const FOMO_ERR_COOLDOWN = 20000;
      let fomoStats = { key: '', holders: null, thesisCount: null, supply: 0, updatedAt: 0 };
      function loadFomoSupply() {} function renderFomoStats() {} function renderTokenHeaderBadges() {}
      function renderFomoItems(target, items, kind) { rendered.push(kind); target.replaceChildren(document.createTextNode(kind)); }
      async function buildFomoErrorBox() { return document.createElement('div'); }
      ${code}
      return (async () => {
        await loadFomoData(true);
        const folded = { calls: [...calls], rendered: [...rendered], listChildren: list.childNodes.length, total: fomoStats.holders?.total, lastItems: fomoLastItems, key: fomoLoadedKey };
        await loadFomoData(false);
        const repeat = calls.length;
        fomoPanelEl.classList.remove('is-folded');
        await loadFomoData(true);
        return { folded, repeat, unfolded: { calls: [...calls], rendered: [...rendered], key: fomoLoadedKey } };
      })();
    `);
    return run();
  }, { code: extract(content, 'loadFomoData') });
  assert.deepEqual(gmgnFold.folded, { calls: ['holders'], rendered: [], listChildren: 0, total: 3, lastItems: ['keep'], key: 'holders|bsc|0xabc' });
  assert.equal(gmgnFold.repeat, 1, '同一代币折叠态不重复请求');
  assert.deepEqual(gmgnFold.unfolded, { calls: ['holders', 'thesis'], rendered: ['thesis'], key: 'thesis|bsc|0xabc' });
  pass('GMGN 浮窗折叠时只拉持仓者、不渲染列表、不覆盖当前页签数据；展开后按当前页签（观点）加载');

  const debotFold = await page.evaluate(({ code }) => {
    const run = new Function(`
      const calls = [], rendered = [], statsCalls = [];
      const route = { chain: 'bsc', address: '0xabc', networkId: 56 };
      function debotTokenRoute() { return route; }
      async function runtimeMessage(msg) { calls.push(msg.payload.kind); return { ok: true, items: [{ value: 5 }], total: 7 }; }
      const panel = document.createElement('section'); panel.className = 'gdh-debot-fomo is-folded';
      const list = document.createElement('div'); list.className = 'gdh-debot-fomo__list';
      panel.append(list); document.body.append(panel);
      let panelTab = 'swaps', panelLoadedKey = '', panelLoading = false, panelItems = ['keep'];
      let panelStats = { key: '', holders: null, thesisCount: null, supply: 0 };
      function loginGuide() {} function renderPanelStats() {}
      function renderItems(target, items, kind) { rendered.push(kind); }
      function loadPanelStats(r, folded) { statsCalls.push(folded); }
      ${code}
      return (async () => {
        await loadPanel(true);
        const folded = { calls: [...calls], rendered: [...rendered], statsFolded: statsCalls[0], items: panelItems, total: panelStats.holders?.total, listChildren: list.childNodes.length };
        panel.classList.remove('is-folded');
        await loadPanel(true);
        return { folded, unfolded: { calls: [...calls], rendered: [...rendered], statsFolded: statsCalls[1], items: panelItems.length } };
      })();
    `);
    return run();
  }, { code: extract(debot, 'loadPanel') });
  assert.deepEqual(debotFold.folded, { calls: ['holders'], rendered: [], statsFolded: true, items: ['keep'], total: 7, listChildren: 0 });
  assert.deepEqual(debotFold.unfolded, { calls: ['holders', 'swaps'], rendered: ['swaps'], statsFolded: false, items: 1 });

  const statsCalls = await page.evaluate(({ code }) => {
    const run = new Function(`
      const kinds = [];
      let panel = document.createElement('section');
      async function runtimeMessage(msg) { if (msg.type === 'fomo-token-feed') kinds.push(msg.payload.kind); return { ok: true, items: [], total: 1 }; }
      async function loadDebotTokenSupply() { return 0; }
      function renderPanelStats() {}
      let panelStats = { key: '', holders: null, thesisCount: null, supply: 0 };
      ${code}
      return (async () => {
        await loadPanelStats({ chain: 'bsc', address: '0x1', networkId: 56 }, true);
        const folded = [...kinds];
        await loadPanelStats({ chain: 'bsc', address: '0x2', networkId: 56 }, false);
        return { folded, all: kinds };
      })();
    `);
    return run();
  }, { code: extract(debot, 'loadPanelStats') });
  assert.deepEqual(statsCalls, { folded: ['holders'], all: ['holders', 'holders', 'thesis'] });
  pass('DeBot 浮窗折叠时只拉持仓者（统计也不再为观点条数单独请求）；展开后按当前页签加载');

  // 7. 展开按钮会补拉当前页签
  assert.ok(content.includes("if (!settings.fomoPanelFolded) {\n        fomoLoadedKey = '';\n        loadFomoData(true);"));
  assert.ok(debot.includes("if (!settings.debotFomoPanelFolded) { panelLoadedKey = ''; loadPanel(true); }"));
  pass('两边展开折叠面板时都会按当前页签重新加载列表');
} finally { await browser.close(); }
console.log(`FOMO request budget: ${checks} checks passed`);
