// Offline session fixtures: never reads a real browser token or logs into FOMO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
let count = 0;
const pass = name => console.log(`PASS ${++count}: ${name}`);
const jwt = exp => `a.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.z`;
const context = (names, extra) => { const ctx = vm.createContext({ URL, Date, Promise, Set, Response, atob, setTimeout, clearTimeout, ...extra }); vm.runInContext(names.map(n => n === 'fomoAuthedFetch' ? source.slice(source.indexOf('async function fomoAuthedFetch('), source.indexOf('async function fomoFetchToken(')) : extract(source, n)).join('\n'), ctx); return ctx; };

let calls = 0;
const sdk = { ready: true, authenticated: true, login() {}, logout() {}, getAccessToken: async () => { calls++; return jwt(Date.now() + 3600000); } };
const el = { '__reactFiber$fixture': { return: { memoizedProps: { value: sdk } } } };
const page = context(['fomoPageSdkAccess'], { location: { hostname: 'fomo.family' }, document: { body: el, querySelectorAll: () => [] } });
assert.equal((await page.fomoPageSdkAccess()).status, 'ready'); assert.equal(calls, 0);
const renewed = await page.fomoPageSdkAccess(true);
assert.equal(renewed.status, 'renewed'); assert.equal(calls, 1); assert.deepEqual(Object.keys(renewed).sort(), ['exp', 'status']);
pass('定位页面现有 Privy Provider，只调用 getAccessToken，只返回脱敏状态');
sdk.authenticated = false; assert.equal((await page.fomoPageSdkAccess(true)).status, 'signed-out'); assert.equal(calls, 1);
sdk.ready = false; assert.equal((await page.fomoPageSdkAccess(true)).status, 'not-ready');
page.document.body = {}; assert.equal((await page.fomoPageSdkAccess(true)).status, 'sdk-missing');
pass('未登录、未水合和营销首页不冒充可续期应用页，也不触发登录或交易');

const ops = [];
let tabs = [{ id: 1, url: 'https://fomo.family/', discarded: false }];
const keeperStore = {};
const owner = context(['fomoTabUrl', 'fomoRecoverKeeper', 'fomoSelectSdkOwner', 'fomoEnsureSdkOwner'], {
  FOMO_KEEPER_STATE_KEY: 'fomoKeeperTabsV1', fomoOwnerInFlight: null, fomoPageWasKeeper() {},
  FOMO_KEEPER_URL: 'https://fomo.family/token?gdh_keeper=1', fomoAuthNote: async () => {}, fomoOpenTabs: async () => tabs,
  fomoSdkAccess: async () => ({ status: 'ready' }),
  chrome: { storage: { session: { get: async () => keeperStore, set: async values => Object.assign(keeperStore, values) } },
    scripting: { executeScript: async () => [{ result: false }] },
    tabs: { create: async opts => { ops.push(['create', opts]); const tab = { id: 2, ...opts }; tabs.push(tab); return tab; },
    get: async id => tabs.find(t => t.id === id),
    update: async (id, opts) => { ops.push(['update', id, opts]); return Object.assign(tabs.find(t => t.id === id), opts); },
    reload: async id => ops.push(['reload', id]), remove: async id => { ops.push(['remove', id]); tabs = tabs.filter(t => t.id !== id); } } },
});
assert.equal((await owner.fomoEnsureSdkOwner()).id, 2); await owner.fomoEnsureSdkOwner();
assert.equal(ops.filter(x => x[0] === 'create').length, 1); assert.equal(ops.filter(x => x[0] === 'reload').length, 0);
assert.match(ops[0][1].url, /\/token\?/); assert.equal(ops[0][1].active, false);
pass('首页心跳不当作 SDK，创建真实应用守护页后不重复开页或重载');
tabs = [{ id: 4, url: 'https://fomo.family/?gdh_keeper=1', pinned: true }]; ops.length = 0;
await owner.fomoEnsureSdkOwner(); assert.equal(ops[0][2].url, 'https://fomo.family/token?gdh_keeper=1');
pass('旧首页 keeper 原位迁移到应用页，不增加第二个守护页');
tabs = [{ id: 3, url: 'https://fomo.family/profile/test', active: true }, { id: 4, url: 'https://fomo.family/token?gdh_keeper=1', pinned: true }]; ops.length = 0;
assert.equal((await owner.fomoEnsureSdkOwner()).id, 3); assert.equal(ops.filter(x => x[0] === 'reload').length, 0);
assert.equal(ops.find(x => x[0] === 'remove')[1], 4);
pass('已登录真实应用页接管后只关闭扩展自己的 keeper，不刷新用户页');

const store = { fomoToken: { token: 'old', exp: Date.now() - 10000 } };
let starts = 0, renewCalls = 0, mode = 'success';
const healthCalls = [];
const makeRecovery = () => context(['fomoRefreshSession'], {
  fomoRefreshInFlight: null, FOMO_REFRESH_RETRY_MS: 300000, fomoAuthNote: async () => {},
  // keeper 健康检查由 verify-fomo-keeper.mjs 覆盖，这里只需声明这个协作者
  fomoKeeperHealth: async (id, status) => { healthCalls.push([id, status]); },
  fomoEnsureSdkOwner: async () => { starts++; return { id: 2 }; },
  fomoSdkAccess: async (_id, renew) => {
    if (mode === 'failure') return { status: 'signed-out' };
    if (!renew) return { status: 'ready' }; renewCalls++;
    store.fomoToken = { token: 'new', exp: Date.now() + 3600000 }; return { status: 'renewed', exp: store.fomoToken.exp };
  }, fomoWaitMirror: async () => null,
  chrome: { storage: { local: { get: async () => ({ ...store }), set: async values => Object.assign(store, values) } },
    scripting: { executeScript: async () => [] }, tabs: { sendMessage: async () => ({ ok: true }) } },
});
let recovery = makeRecovery(); const both = await Promise.all([recovery.fomoRefreshSession(), recovery.fomoRefreshSession()]);
assert.equal(both[0].token, 'new'); assert.equal(both[1].token, 'new'); assert.equal(starts, 1); assert.equal(renewCalls, 1);
pass('多个面板并发续期合并为一次 SDK 调用，新令牌在本地恢复');
assert.deepEqual(healthCalls, [['renewed']].map(([s]) => [2, s]));
pass('每轮续期都回报一次 keeper 健康状态（坏页才能被回收）');
store.fomoToken = { token: 'expired', exp: Date.now() - 10000 }; store.fomoSessionRecoveryV1 = null; mode = 'failure';
assert.equal(await recovery.fomoRefreshSession(), null); const before = starts;
assert.equal(await recovery.fomoRefreshSession(), null); recovery = makeRecovery(); assert.equal(await recovery.fomoRefreshSession(), null);
assert.equal(starts, before); assert.equal(store.fomoSessionRecoveryV1.status, 'signed-out');
assert.ok(store.fomoSessionRecoveryV1.retryAt > Date.now()); assert.ok(!JSON.stringify(store.fomoSessionRecoveryV1).includes('expired'));
pass('失败五分钟冷却落盘，SW 重启也不重复开页；诊断不含凭证');
store.enabled = false; store.fomoSessionRecoveryV1 = null;
assert.equal(await recovery.fomoRefreshSession(), null); assert.equal(starts, before);
delete store.enabled;
pass('关闭插件总开关后不再创建守护页或调用 SDK 续期');

let upstream = 0;
const fetcher = context(['fomoAuthedFetch', 'fomoBodyUnauthed', 'fomoResponseUnauthed'], {
  FOMO_API: 'https://prod-api.fomo.family', FOMO_CHAINS: '1,56', fomoRefreshSession: async () => null,
  fomoQueuedFetch: fn => fn(), fetch: async () => { upstream++; return new Response('{}'); },
  chrome: { storage: { local: { get: async () => ({ fomoToken: store.fomoToken }) } } },
});
assert.equal((await fetcher.fomoAuthedFetch('/fixture')).unauthed, true); assert.equal(upstream, 0);
pass('确定过期且恢复未成功时，不反复拿旧 JWT 请求官方 API');

let scheduled;
const alarm = context(['fomoScheduleExpiry'], { FOMO_EXPIRY_ALARM: 'expiry', chrome: { storage: { local: { get: async () => ({ fomoToken: { token: 'fixture', exp: Date.now() + 3600000 } }) } }, alarms: { get: async () => null, create: async (_name, opts) => { scheduled = opts.when; } } } });
await alarm.fomoScheduleExpiry(); assert.ok(scheduled > Date.now() + 3560000 && scheduled < Date.now() + 3580000);
pass('以 JWT 有效期安排过期前检查，不只依赖后台五分钟轮询');
const consent = context(['fomoRankContributionAllowed'], {});
assert.equal(consent.fomoRankContributionAllowed({}), false);
assert.equal(consent.fomoRankContributionAllowed({ enableFomoRankContribution: false }), false);
assert.equal(consent.fomoRankContributionAllowed({ fomoRankCollectorConsentV1: { version: 1, acceptedAt: 1 } }), true);
assert.equal(consent.fomoRankContributionAllowed({ enableFomoRankContribution: true }), true);
pass('移除独立开关后，必须确认更新说明；旧明确授权保留，不静默启用');
const mirror = fs.readFileSync(new URL('../fomo-early.js', import.meta.url), 'utf8');
assert.ok(!/localStorage\.setItem/.test(mirror)); assert.match(mirror, /fomo-sync-now/); assert.match(mirror, /__gdhFomoMirrorVersion/);
assert.ok(!source.includes('auth.privy.io/api/v1/sessions'));
pass('镜像只读，支持扩展更新后重注入；不裸调 refresh 或把旧会话写回 FOMO');

let timeoutCleared = false;
const hanging = context(['fomoSdkAccess'], { fomoPageSdkAccess() {}, chrome: { scripting: { executeScript: () => new Promise(() => {}) } },
  setTimeout: callback => { queueMicrotask(callback); return 1; }, clearTimeout: () => { timeoutCleared = true; } });
assert.equal((await hanging.fomoSdkAccess(1, true)).status, 'sdk-timeout'); assert.equal(timeoutCleared, true);
pass('SDK 卡住有有界超时，正常清理计时器');
const content = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const debot = fs.readFileSync(new URL('../debot-content.js', import.meta.url), 'utf8');
assert.ok(content.includes("key !== 'fomoSessionRecoveryV1'")); assert.ok(debot.includes("key !== 'fomoSessionRecoveryV1'"));
pass('续期诊断存储不唤醒 GMGN / DeBot 整页扫描');

const intervals = new Set(), listeners = new Set(); let tid = 0, localWrites = 0;
const mirrored = {};
const pageStore = { 'privy:token': JSON.stringify(jwt(Date.now() + 3600000)), 'privy:refresh_token': JSON.stringify('fixture-refresh-credential-long') };
const windowFixture = { localStorage: { ...pageStore, getItem: k => pageStore[k], setItem: () => { localWrites++; } },
  setInterval: () => { const id = ++tid; intervals.add(id); return id; }, clearInterval: id => intervals.delete(id), addEventListener() {}, removeEventListener() {} };
const mirrorCtx = vm.createContext({ URLSearchParams, Date, atob, location: { hostname: 'fomo.family', search: '' }, window: windowFixture,
  document: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
  chrome: { runtime: { id: 'fixture', getManifest: () => ({ version: '0.46.72' }), sendMessage: (_m, callback) => callback(),
    onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    storage: { local: { get: (_k, callback) => callback(mirrored), set: value => Object.assign(mirrored, value) } } } });
vm.runInContext(mirror, mirrorCtx); vm.runInContext(mirror, mirrorCtx);
assert.equal(intervals.size, 2); assert.equal(listeners.size, 1); assert.equal(localWrites, 0);
assert.ok(mirrored.fomoToken.exp > Date.now()); windowFixture.__gdhFomoMirrorCleanup(); assert.equal(intervals.size, 0);
pass('同版本重载可替换失效镜像，重复注入只保留一组监听且不写网页凭据');
console.log(`1..${count}`);
