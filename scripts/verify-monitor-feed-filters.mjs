// Offline synthetic accounts/events only; no real user settings or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import filters from '../monitor-feed-filters.js';
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const content = read('content.js'), debot = read('debot-content.js');
const audit = read('scripts/verify-audit-fixes.mjs');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
let tests = 0;
const pass = name => console.log(`PASS ${++tests}: ${name}`);
const snapshot = raw => filters.captureChannels(raw, 'fixture-user');
const raw = { connected: true, wallet: 'fixture-user', watch: ['alice', 'fixture-wallet'], muted: [], prefs: {}, filters: {}, tokenFilters: [], globalTradeMinUsd: 0 };
const fomo = { key: 'fomo-1', source: 'fomo', handle: 'alice', type: 'buy', chain: 'sol', addr: 'fixture-mint', symbol: 'TEST', ts: 1000, usd: 20 };
const pump = { ...fomo, key: 'pump-1', source: 'pump', pumpWallet: 'fixture-wallet', ts: 1001 };

assert.deepEqual(snapshot({ chainFilters: { fomo: { solana: false, bnb: true }, pump: { bnb: false, other: false } } }), {
  accountId: 'fixture-user', fomo: { enabled: true, blockedChains: ['solana'] }, pump: { enabled: true, blockedChains: ['bnb', 'other'] },
});
assert.deepEqual(snapshot({ chainFilters: { fomo: { solana: 0, bnb: 'false', unexpected: false } } }).fomo.blockedChains, []);
pass('只读取明确关闭的已知链，不把字符串、数字或未知键当成屏蔽');
for (const [name, expected] of [['sol', 'solana'], ['Solana', 'solana'], ['bsc', 'bnb'], ['BNB Chain', 'bnb'], ['eth', 'eth'], ['base', 'base'], ['robinhood', 'robinhood'], ['hyperevm', 'hyperliquid'], ['monad', 'monad'], ['arc', 'other'], ['unknown', 'other']]) {
  assert.equal(filters.chainOf({ chain: name }), expected);
}
assert.equal(filters.chainOf({ networkId: 1399811149 }), 'solana');
assert.equal(filters.chainOf({ networkId: 5042 }), 'other');
assert.equal(filters.chainOf({ networkId: 999 }), 'hyperliquid');
pass('链名及 ID 与网页链分组一致，Arc 按网页“其他”处理');
const solBlocked = snapshot({ chainFilters: { fomo: { solana: false }, pump: { solana: false } } });
assert.equal(filters.allowed(fomo, 'fomo', solBlocked, raw), false);
assert.equal(filters.allowed(fomo, 'fomo', solBlocked, { ...raw, wallet: 'another-user' }), true);
assert.equal(filters.allowed(fomo, 'fomo', solBlocked, { ...raw, connected: false }), false);
assert.equal(filters.allowed(fomo, 'fomo', null, raw), true);
assert.equal(filters.allowed(pump, 'pump', snapshot({ 'pump-trade': false }), raw), false);
assert.equal(filters.allowed(pump, 'pump', snapshot({ 'pump-callout': false }), raw), true);
pass('按账号隔离，断开时不出推送；Pump 喊单开关不误伤成交');

function fixture(source) {
  const isDebot = source === debot;
  const c = vm.createContext({ GdhMonitorFeedFilters: filters, monitor985ChannelPrefs: null,
    monitorFomoCfg: null, monitorPumpCfg: null, monitorFomo: null, monitorPump: null,
    settings: { fomoFeedTypes: {} }, DEFAULTS: { fomoFeedTypes: {} },
    PUMP_FEED_DEFAULT_TOKEN_FILTERS: [], PUMP_DEFAULT_TOKEN_FILTERS: [],
    pumpDefaultWallets: new Set(), FOMO_FEED_RENDER_CAP: 160, FEED_RENDER_CAP: 160,
    fomoFeedEvents: [fomo], pumpFeedEvents: [pump], fomoEvents: [fomo], pumpEvents: [pump],
    safeText: (value, limit = 999) => String(value || '').slice(0, limit),
    normalizeAddress: value => String(value || ''), isTokenBlocked: () => false,
    currentChainSlug: () => '', currentTrackChain: () => '',
    trackingFeedEventIdentity: ev => ev.key, eventIdentity: ev => ev.key,
    trackingFeedBurstDuplicate: () => false, trackingFeedIsNativeDuplicate: () => false, isNativeDuplicate: () => false,
  });
  const functions = isDebot
    ? ['pumpTokenKey', 'loadMonitorFomo', 'loadMonitorPump', 'blockedTokenSet', 'fomoAllowed', 'pumpAllowed', 'visibleFeedEvents']
    : ['pumpFeedTokenKey', 'loadMonitorFomoCfg', 'loadMonitorPumpCfg', 'fomoFeedEventAllowed', 'pumpFeedEventAllowed', 'visibleTrackingFeedEvents'];
  vm.runInContext(functions.map(name => extract(source, name)).join('\n'), c);
  const load = (f = raw, p = raw) => isDebot ? (c.loadMonitorFomo(f), c.loadMonitorPump(p)) : (c.loadMonitorFomoCfg(f), c.loadMonitorPumpCfg(p));
  load();
  return { c, load, visible: () => Array.from(isDebot ? c.visibleFeedEvents() : c.visibleTrackingFeedEvents()),
    f: ev => isDebot ? c.fomoAllowed(ev, new Set()) : c.fomoFeedEventAllowed(ev),
    p: ev => isDebot ? c.pumpAllowed(ev, new Set()) : c.pumpFeedEventAllowed(ev) };
}
for (const [name, source] of [['GMGN', content], ['DeBot', debot]]) {
  const t = fixture(source);
  assert.equal(t.visible().length, 2);
  // 「推送只看当前链」必须同时管住 fomo 与 Pump 两路。
  // GMGN 侧曾经只过滤了 fomo，Pump 那个循环漏了链判断，开着开关照样冒出别的链。
  const onChain = (slug) => { t.c.currentChainSlug = () => slug; t.c.currentTrackChain = () => slug; };
  t.c.settings.fomoFeedChainOnly = true;
  onChain('bsc');
  assert.deepEqual(t.visible().map(ev => ev.source), [], '页面在别的链时两路推送都要隐藏');
  onChain('sol');
  assert.deepEqual(t.visible().map(ev => ev.source).sort(), ['fomo', 'pump'], '当前链的事件照常显示');
  t.c.settings.fomoFeedChainOnly = false;
  onChain('bsc');
  assert.equal(t.visible().length, 2, '关掉开关就回到全链');
  onChain('');
  pass(`${name} 「只看当前链」同时约束 fomo 与 Pump 两路推送`);
  t.c.monitor985ChannelPrefs = solBlocked;
  assert.equal(t.visible().length, 0, 'cached rows must be filtered again without receiving new events');
  assert.equal(t.f({ ...fomo, chain: 'bsc' }), true);
  assert.equal(t.p({ ...pump, chain: 'bsc' }), true);
  t.c.monitor985ChannelPrefs = snapshot({});
  assert.equal(t.visible().length, 2, 'unblocking restores eligible cached rows');
  t.c.monitor985ChannelPrefs = snapshot({ fomo: false });
  assert.equal(t.visible().length, 1);
  t.c.monitor985ChannelPrefs = snapshot({ chainFilters: { pump: { other: false } } });
  assert.equal(t.p({ ...pump, chain: 'arc' }), false);
  pass(`${name} 缓存随链/来源开关重新过滤，取消屏蔽恢复，BSC 不受 Solana 屏蔽影响`);
  t.c.monitor985ChannelPrefs = null;
  t.load({ ...raw, muted: ['alice'] }, { ...raw, muted: ['fixture-wallet'] });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, prefs: { alice: { types: { buy: false } } } }, { ...raw, prefs: { 'fixture-wallet': { types: { buy: false } } } });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, prefs: { alice: { soundTypes: { buy: false } } } }, { ...raw, prefs: { 'fixture-wallet': { soundTypes: { buy: false } } } });
  assert.equal(t.visible().length, 2);
  pass(`${name} 整人/事件屏蔽生效，声音静音不会当成屏蔽`);
  t.load({ ...raw, tokenFilters: ['TEST'] }, { ...raw, tokenFilters: ['TEST'] });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, globalTradeMinUsd: 30 }, { ...raw, globalTradeMinUsd: 30 });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, filters: { alice: { minTradeUsd: 30 } } }, { ...raw, filters: { 'fixture-wallet': { minTradeUsd: 30 } } });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, watch: [] }, { ...raw, watch: [] });
  assert.equal(t.visible().length, 0);
  t.load({ ...raw, connected: false }, { ...raw, connected: false });
  assert.equal(t.visible().length, 0);
  pass(`${name} 币种/金额/关注和断开过滤完整，明确空名单不套默认币过滤`);
}

const ag = fixture(content); let packet;
ag.c.document = { documentElement: { getAttribute: () => '1', setAttribute: (_key, value) => { packet = JSON.parse(value); } }, dispatchEvent: () => {} };
ag.c.Event = class { };
vm.runInContext(extract(content, 'publishBuyAggregateFeeds'), ag.c);
ag.c.publishBuyAggregateFeeds(); assert.equal(packet.fomo.length + packet.pump.length, 2);
ag.c.monitor985ChannelPrefs = solBlocked;
ag.c.publishBuyAggregateFeeds(['fomo', 'pump']);
assert.equal(packet.fomo.length + packet.pump.length, 0); assert.deepEqual(packet.reset, ['fomo', 'pump']);
assert.ok(content.includes("Object.hasOwn(changes, 'monitor985ChannelPrefsV1')"));
pass('聚合监控同时移除已屏蔽来源的缓存，不继续用旧事件计数或触发警报');
const manifest = JSON.parse(read('manifest.json'));
for (const entry of manifest.content_scripts.filter(x => x.js?.includes('debot-content.js') || x.js?.includes('content.js') && !x.matches.some(m => m.includes('fomo.family')))) {
  assert.equal(entry.js[0], 'monitor-feed-filters.js');
}
assert.ok(read('scripts/build-release.ps1').includes("'monitor-feed-filters.js'"));
assert.ok(read('background.js').includes("files: ['monitor-feed-filters.js', 'content.js']"));
pass('GMGN/DeBot/985monitor 与升级后补注入均先加载过滤器，发布包不会漏模块');
console.log(`${tests} monitor feed filter checks passed.`);
