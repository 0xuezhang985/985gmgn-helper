// Offline fixtures only: no real accounts, browser credentials, or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import GdhMonitorFeedFilters from '../monitor-feed-filters.js';
const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const bridge = content.slice(0, content.indexOf('  // 战壕卡：')) + '})();';
let tests = 0;
const pass = name => console.log(`PASS ${++tests}: ${name}`);
const sender = id => ({ tab: { id, url: 'https://985monitor.xyz/' }, url: 'https://985monitor.xyz/' });
function fixture(stored = {}) {
  const state = { stored: structuredClone(stored), requests: [], pages: [], writes: [], status: 200, sequence: 0 };
  const local = {
    get: async (defaults, callback) => {
      const value = typeof defaults === 'string' ? { [defaults]: state.stored[defaults] }
        : Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, state.stored[k] ?? v]));
      callback?.(structuredClone(value)); return structuredClone(value);
    },
    set: async value => { Object.assign(state.stored, structuredClone(value)); state.writes.push(structuredClone(value)); },
  };
  const coordinator = vm.createContext({ URL, Date, crypto: { randomUUID: () => `lease-${++state.sequence}` },
    monitor985SyncLease: null, monitor985SyncRetryAt: 0, chrome: { storage: { local } },
    resetMonitor985EventCaches: () => { state.cleared = (state.cleared || 0) + 1; } });
  for (const name of ['acquireMonitor985SyncLease', 'releaseMonitor985SyncLease', 'monitor985SessionIsCurrent', 'markMonitor985Disconnected']) {
    if (background.includes(`function ${name}(`)) vm.runInContext(extract(background, name), coordinator);
  }
  state.coordinator = coordinator;
  state.open = (id, host = '985monitor.xyz', auth = true, alive = true) => {
    const page = { timers: [], messages: [], events: {}, values: {} };
    const chrome = { storage: { local: { ...local, set: (v, cb) => local.set(v).then(() => cb?.()) } },
      runtime: { id: alive ? 'fixture-extension' : undefined, lastError: null, onMessage: { addListener: f => page.messages.push(f) },
        sendMessage: (m, cb) => {
          let value = { ok: true };
          if (m.type === '985-monitor-sync-acquire') value = coordinator.acquireMonitor985SyncLease(sender(id));
          if (m.type === '985-monitor-sync-release') value = coordinator.releaseMonitor985SyncLease(m, sender(id));
          cb?.(value); return Promise.resolve(value);
        } } };
    const w = { localStorage: { getItem: k => page.values[k] ?? (auth ? ({ xMonitorWalletAddress: 'fixture-user', xMonitorWalletToken: 'page-only' })[k] || null : null) },
      setInterval: f => page.timers.push(f), addEventListener: (name, fn) => { page.events[name] = fn; } };
    vm.runInNewContext(bridge, { window: w, location: { hostname: host }, document: { addEventListener: () => {} },
      chrome, GdhMonitorFeedFilters, crypto: { randomUUID: () => 'fixture-client' }, AbortSignal, Date, setTimeout, clearTimeout,
      fetch: async (path, options) => {
        state.requests.push({ path, body: JSON.parse(options.body) });
        await new Promise(r => setTimeout(r, 10));
        const seq = state.requests.length;
        return { ok: state.status === 200, status: state.status, headers: { get: () => '60' }, json: async () => ({
          ok: state.status === 200, config: { connected: true, account: { userId: 'fixture-user' }, fomo: {}, pump: {} },
          ...(path.endsWith('/session') ? { session: { token: `extension-${seq}`, clientId: 'fixture-client', expiresAt: Date.now() + 90 * 86400000 } } : {}),
        }) };
      } });
    state.pages.push(page); return page;
  };
  state.settle = () => new Promise(r => setTimeout(r, 70));
  return state;
}

const many = fixture();
for (let i = 0; i < 6; i++) many.open(i + 1, i ? '985monitor.xyz' : 'www.985monitor.xyz');
await many.settle();
assert.equal(many.requests.filter(r => r.path.endsWith('/session')).length, 1, 'multiple tabs must not rotate the same session');
assert.ok(many.stored.monitor985SessionV1?.token);
assert.ok(!JSON.stringify(many.stored).includes('page-only'));
pass('六个跨子域页面同时启动，只签发一次只读会话，网页主令牌不落盘');

for (const p of many.pages) p.timers[0]();
await many.settle();
assert.equal(many.requests.filter(r => r.path.endsWith('/session')).length, 1);
pass('随后同步复用会话，不重复签发');

const channels = fixture();
const channelPage = channels.open(1);
await channels.settle();
const initialRequests = channels.requests.length;
channelPage.values.xMonitorPushChannelsV1 = JSON.stringify({ chainFilters: { fomo: { solana: false }, pump: { solana: false } } });
channelPage.events['xmonitor:preferences-status']();
await new Promise(r => setTimeout(r, 350));
assert.deepEqual(channels.stored.monitor985ChannelPrefsV1.fomo.blockedChains, ['solana']);
assert.deepEqual(channels.stored.monitor985ChannelPrefsV1.pump.blockedChains, ['solana']);
assert.equal(channels.requests.length, initialRequests, 'channel edits should not issue an extra HTTP request');
assert.equal(channels.stored.monitor985ChannelPrefsV1.accountId, 'fixture-user');
pass('网页同页修改链屏蔽自动同步，两路独立配置，不增加 HTTP 请求');
channelPage.values.xMonitorPushChannelsV1 = JSON.stringify({ 'pump-trade': false, chainFilters: {} });
channelPage.events['xmonitor:preferences-applied']();
await new Promise(r => setTimeout(r, 350));
assert.deepEqual(channels.stored.monitor985ChannelPrefsV1.fomo.blockedChains, []);
assert.equal(channels.stored.monitor985ChannelPrefsV1.pump.enabled, false);
const channelWrites = channels.writes.length;
channelPage.events['xmonitor:preferences-status']();
await new Promise(r => setTimeout(r, 350));
assert.equal(channels.writes.length, channelWrites, 'unchanged preferences must not rewrite extension storage');
pass('取消屏蔽及来源开关可同步，不变配置不重复写入');
channelPage.values.xMonitorUiOwnerV1 = 'another-account';
channelPage.values.xMonitorPushChannelsV1 = JSON.stringify({ fomo: false });
channelPage.timers[0](); await channels.settle();
assert.equal(channels.stored.monitor985ChannelPrefsV1.fomo.enabled, true);
pass('账号偏好恢复未完成时，不把另一账号的页面镜像写入当前账号');

const c = many.coordinator;
const lock = c.acquireMonitor985SyncLease(sender(10));
assert.ok(lock.ok);
assert.equal(c.acquireMonitor985SyncLease(sender(11)).ok, false);
assert.equal(c.releaseMonitor985SyncLease({ lease: lock.lease }, sender(11)).ok, false);
assert.equal(c.releaseMonitor985SyncLease({ lease: 'wrong' }, sender(10)).ok, false);
assert.equal(c.releaseMonitor985SyncLease({ lease: lock.lease }, sender(10)).ok, true);
assert.equal(c.acquireMonitor985SyncLease({ tab: { id: 1 }, url: 'https://evil.test/' }).ok, false);
pass('同步互斥跨页面生效，非持有人和非 985monitor 页面不能释放或占用');

vm.runInContext('monitor985SyncLease = { tabId: 7, lease: "abandoned", expiresAt: 1 }', c);
assert.equal(c.acquireMonitor985SyncLease(sender(12)).ok, true);
pass('已关闭或失去响应页面的同步锁可以超时恢复');

const limited = fixture(); limited.status = 429; limited.open(1); await limited.settle();
limited.open(2); await limited.settle();
assert.equal(limited.requests.length, 1);
assert.equal(limited.stored.monitor985SessionV1, undefined);
pass('签发接口限流时全页面共同退避，不轮番重试');

const loggedOut = fixture({ monitor985SessionV1: { token: 'extension-valid', expiresAt: Date.now() + 90 * 86400000, accountId: 'fixture-user' }, monitor985SyncStateV1: { connected: true } });
loggedOut.open(1, '985monitor.xyz', false); await loggedOut.settle();
assert.equal(loggedOut.stored.monitor985SyncStateV1.connected, true);
assert.equal(loggedOut.requests.length, 0);
pass('未登录的其他页面不会把已连接扩展标成断开');

const invalid = fixture(); invalid.open(1, '985monitor.xyz', true, false); await invalid.settle();
invalid.pages[0].timers[0](); await invalid.settle();
assert.equal(invalid.requests.length, 0);
pass('升级后失效的旧上下文停止签发，不再挤掉有效会话');

const newer = { token: 'new-session', expiresAt: Date.now() + 100000 };
const stale = fixture({ monitor985SessionV1: newer, monitor985SyncStateV1: { connected: true } });
assert.equal(await stale.coordinator.markMonitor985Disconnected('unauthorized', true, { token: 'old-session' }), false);
assert.equal(stale.stored.monitor985SessionV1.token, 'new-session');
assert.equal(stale.cleared, undefined);
pass('旧请求的 401 不会清空新会话或事件缓存');
assert.equal(await stale.coordinator.markMonitor985Disconnected('unauthorized', true, newer), true);
assert.equal(stale.stored.monitor985SessionV1, null);
assert.equal(stale.stored.monitor985SyncStateV1.connected, false);
pass('当前会话真正失效时仍清理鉴权状态，不绕过权限');

for (const name of ['fetchFomoFeed', 'fetchPumpFeed', 'refreshMonitor985Config', 'connectFomoSse']) {
  const fn = extract(background, name);
  assert.ok(fn.includes('monitor985SessionIsCurrent(session)'), `${name} must discard replaced sessions`);
  assert.ok(fn.includes("markMonitor985Disconnected('unauthorized', true, session)"), `${name} must scope unauthorized errors`);
}
pass('配置、两路历史事件和实时流都拒绝过期请求结果');

let streams = 0;
const sse = vm.createContext({ URL, Date, AbortController, TextDecoder,
  fomoSseAbort: null, fomoSseGeneration: 0, fomoRankSnapshot: { updatedAt: 0 }, monitor985LastEventId: '',
  FOMO_SSE_URL: 'https://fixture.test/events', fomoRankCollectorAdvertised: false,
  monitor985Session: async () => ({ token: 'fixture' }), refreshMonitor985Config: async () => true,
  ensureFomoRankSnapshot: async () => {}, monitor985SessionIsCurrent: async () => true,
  fomoRankCollectorEligible: async () => false, monitor985AuthHeaders: () => ({}),
  fetch: async (_url, options) => { streams++; return new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(Error('closed')))); },
  setTimeout: () => 0, fomoSseBackoff: 5000, fomoSseReconnectTimer: 0,
});
vm.runInContext(extract(background, 'connectFomoSse'), sse);
const connections = [sse.connectFomoSse(), sse.connectFomoSse(), sse.connectFomoSse()];
await new Promise(r => setTimeout(r, 20));
assert.equal(streams, 1);
vm.runInContext('fomoSseGeneration++; fomoSseAbort.abort()', sse); await Promise.all(connections);
pass('并发唤醒完成异步配置检查后仍只创建一条实时连接');
console.log(`${tests} monitor feed session checks passed.`);
