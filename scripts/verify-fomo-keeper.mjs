// Offline tab-lifecycle fixtures. Never opens FOMO or reads real credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const extract = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const names = ['fomoTabUrl', 'fomoOpenTabs', 'fomoPageWasKeeper', 'fomoRecoverKeeper', 'fomoSelectSdkOwner', 'fomoEnsureSdkOwner', 'fomoKeeperHealth'];
const keeperUrl = 'https://fomo.family/token?gdh_keeper=1';
const appUrl = 'https://fomo.family/tokens/bnb/fixture';
let count = 0;
const pass = name => console.log(`PASS ${++count}: ${name}`);
function fixture(initial = []) {
  const state = { tabs: initial.map(t => ({ pinned: false, active: false, discarded: false, ...t })), ops: [], session: {}, fail: '', statuses: {}, next: 100, beforeGet: null };
  const chrome = {
    storage: { session: {
      get: async () => { if (state.fail === 'storage') throw Error('storage'); return structuredClone(state.session); },
      set: async values => { if (state.fail === 'write') throw Error('write'); Object.assign(state.session, structuredClone(values)); },
    } },
    scripting: { executeScript: async ({ target }) => {
      state.ops.push(['inspect', target.tabId]);
      return [{ result: !!state.tabs.find(t => t.id === target.tabId)?.initialKeeper }];
    } },
    tabs: {
      query: async () => { if (state.fail === 'query') throw Error('query'); return structuredClone(state.tabs); },
      get: async id => {
        state.beforeGet?.(id);
        if (state.fail === 'get') throw Error('get');
        const tab = state.tabs.find(t => t.id === id); if (!tab) throw Error('closed'); return { ...tab };
      },
      create: async opts => { const tab = { id: state.next++, discarded: false, ...opts }; state.tabs.push(tab); state.ops.push(['create', tab.id]); return { ...tab }; },
      update: async (id, opts) => {
        if (state.fail === 'update') throw Error('update');
        const tab = state.tabs.find(t => t.id === id); if (!tab) throw Error('closed'); Object.assign(tab, opts);
        state.ops.push(['update', id, opts]); return { ...tab };
      },
      reload: async id => { state.ops.push(['reload', id]); state.tabs.find(t => t.id === id).discarded = false; },
      remove: async ids => {
        if (state.fail === 'remove') throw Error('remove');
        for (const id of [ids].flat()) { state.ops.push(['remove', id]); state.tabs = state.tabs.filter(t => t.id !== id); }
      },
    },
  };
  state.restart = () => {
    state.ctx = vm.createContext({ URL, Set, Date, Promise, setTimeout, clearTimeout, chrome, FOMO_KEEPER_URL: keeperUrl,
      FOMO_KEEPER_STATE_KEY: 'fomoKeeperTabsV1', fomoOwnerInFlight: null, fomoAuthNote: async () => {},
      fomoSdkAccess: async id => { state.ops.push(['probe', id]); return { status: state.statuses[id] || 'ready' }; },
    });
    vm.runInContext(names.filter(n => source.includes(`function ${n}(`)).map(n => extract(source, n)).join('\n'), state.ctx);
  };
  state.ensure = () => state.ctx.fomoEnsureSdkOwner();
  state.health = (id, status) => state.ctx.fomoKeeperHealth(id, status);
  state.restart(); return state;
}

const f = fixture();
const first = await f.ensure();
Object.assign(f.tabs[0], { url: appUrl, initialKeeper: true });
await f.ensure(); f.restart(); await f.ensure();
assert.equal(f.ops.filter(o => o[0] === 'create').length, 1);
assert.equal((await f.ensure()).id, first.id);
assert.equal(f.ops.filter(o => o[0] === 'reload').length, 0);
pass('守护页跳到 /tokens 并丢失标记，跨后台重启仍只创建一次');

const ordinary = fixture([{ id: 1, url: appUrl, pinned: true }, { id: 2, url: 'https://fomo.family/profile/user', active: true }]);
assert.equal((await ordinary.ensure()).id, 2); assert.equal(ordinary.ops.filter(o => ['create', 'remove', 'reload'].includes(o[0])).length, 0);
assert.deepEqual(ordinary.session.fomoKeeperTabsV1.owned, []);
pass('用户已打开的代币页和个人页可复用，普通固定页不变成插件所有');

const legacy = fixture([{ id: 1, url: appUrl, active: true }, { id: 2, url: appUrl, pinned: true, initialKeeper: true }, { id: 3, url: appUrl, pinned: true }]);
await legacy.ensure(); assert.deepEqual(legacy.ops.filter(o => o[0] === 'remove'), [['remove', 2]]);
const inspections = legacy.ops.filter(o => o[0] === 'inspect').length;
await legacy.ensure(); assert.equal(legacy.ops.filter(o => o[0] === 'inspect').length, inspections);
pass('从初始加载标记找回旧版遗留页，只清理已确认的多余守护页，身份检查不反复注入');

const adopted = fixture([{ id: 1, url: keeperUrl, pinned: true }]);
await adopted.ensure(); adopted.tabs[0].pinned = false; await adopted.ensure();
adopted.tabs[0].pinned = true;
adopted.tabs.push({ id: 2, url: appUrl, active: true }); await adopted.ensure();
assert.deepEqual(adopted.session.fomoKeeperTabsV1.owned, []);
assert.equal(adopted.ops.filter(o => o[0] === 'remove').length, 0);
pass('用户取消固定后接管页面，即使再次固定也不会自动关闭');

const active = fixture([{ id: 1, url: appUrl, active: true }, { id: 2, url: keeperUrl, pinned: true, active: true }]);
await active.ensure(); assert.equal(active.ops.filter(o => o[0] === 'remove').length, 0);
pass('其他窗口正在看的守护页也不自动关闭');

for (const change of [{ pinned: false }, { active: true }, { url: 'https://example.org/' }, { pendingUrl: 'https://example.org/' }]) {
  const race = fixture([{ id: 1, url: appUrl, active: true }, { id: 2, url: keeperUrl, pinned: true }]);
  race.beforeGet = id => { if (id === 2) Object.assign(race.tabs[1], change); };
  await race.ensure(); assert.equal(race.ops.filter(o => o[0] === 'remove').length, 0);
}
pass('关闭前重新确认：取消固定、激活或离开 FOMO 的竞态均不误关');

for (const status of ['not-ready', 'signed-out', 'sdk-missing', 'page-unavailable']) {
  const loading = fixture([{ id: 1, url: appUrl }, { id: 2, url: keeperUrl, pinned: true }]);
  loading.statuses = { 1: status, 2: status };
  await loading.ensure(); await loading.ensure();
  assert.equal(loading.ops.filter(o => ['create', 'remove'].includes(o[0])).length, 0);
  const onlyUser = fixture([{ id: 3, url: appUrl }]); onlyUser.statuses[3] = status;
  await onlyUser.ensure(); await onlyUser.ensure(); assert.equal(onlyUser.ops.filter(o => o[0] === 'create').length, 0);
}
pass('页面加载中、未登录或 SDK 暂不可用时复用等待，不继续开页或提前清理');

const pending = fixture([{ id: 1, url: 'about:blank', pendingUrl: keeperUrl, pinned: true, status: 'loading' }]);
await pending.ensure(); await pending.ensure(); assert.equal(pending.ops.filter(o => o[0] === 'create').length, 0);
pass('导航尚未完成的 pendingUrl 也能识别，不重复创建');

const root = fixture([{ id: 1, url: 'https://fomo.family/?gdh_keeper=1', pinned: true }]);
assert.equal((await root.ensure()).url, keeperUrl);
assert.equal(root.ops.filter(o => o[0] === 'create').length, 0);
assert.equal(f.ops.filter(o => o[0] === 'update' && o[2].url).length, 0);
pass('仅旧营销首页守护页迁移到应用，已进入代币详情页不被重置');

const discarded = fixture([{ id: 1, url: appUrl, discarded: true }]);
await discarded.ensure(); await discarded.ensure();
assert.equal(discarded.ops.filter(o => o[0] === 'reload').length, 1);
assert.equal(discarded.ops.filter(o => o[0] === 'create').length, 0);
pass('被浏览器丢弃的原页面原位恢复，不增开标签页');

for (const error of ['query', 'storage', 'write']) {
  const failure = fixture(); failure.fail = error;
  assert.equal(await failure.ensure(), null); assert.equal(await failure.ensure(), null);
  assert.equal(failure.ops.filter(o => o[0] === 'create').length, 0);
}
pass('读取标签页或身份存储失败时安全停止，不把失败当成零页面');

for (const error of ['get', 'update', 'remove']) {
  const failure = fixture([{ id: 1, url: appUrl }, { id: 2, url: keeperUrl, pinned: true }]); failure.fail = error;
  await failure.ensure(); assert.equal(failure.ops.filter(o => ['create', 'remove'].includes(o[0])).length, 0);
}
pass('页面操作或清理失败不误删、不通过另开页面重试');

const parallel = fixture(); const results = await Promise.all([parallel.ensure(), parallel.ensure(), parallel.ensure()]);
assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(parallel.ops.filter(o => o[0] === 'create').length, 1);
pass('并发 owner 请求合并为一次创建');

const closed = fixture([{ id: 1, url: appUrl }, { id: 2, url: keeperUrl, pinned: true }]);
closed.beforeGet = id => { if (id === 1) closed.tabs = closed.tabs.filter(t => t.id !== id); };
await closed.ensure(); assert.equal(closed.ops.filter(o => o[0] === 'remove').length, 0);
pass('接管页面中途关闭时保留原守护页');

const nav = vm.createContext({ URL, performance: { getEntriesByType: () => [{ name: keeperUrl }] } });
vm.runInContext(extract(source, 'fomoPageWasKeeper'), nav);
assert.equal(nav.fomoPageWasKeeper(), true);
for (const url of [appUrl, 'https://example.org/?gdh_keeper=1', 'https://fomo.family/?gdh_keeper=0']) {
  nav.performance.getEntriesByType = () => [{ name: url }]; assert.equal(nav.fomoPageWasKeeper(), false);
}
pass('旧 keeper 恢复只认准确的 FOMO 初始地址和标记值');

console.log(`FOMO keeper lifecycle: ${count} checks passed.`);

// ---- keeper 页坏掉（CF 验证页 / 水合失败空壳）必须自愈 ----
// 实测线上日志：01:39→02:49 连续 sdk-missing，同一张 keeper 被每 5 分钟原样重试、永不恢复。
{
  const f = fixture();
  const owner = await f.ensure();                       // 自建一张 keeper
  f.ops.length = 0;
  await f.health(owner.id, 'sdk-missing');              // 第一次坏：重载
  assert.deepEqual(f.ops.filter(o => o[0] === 'reload'), [['reload', owner.id]]);
  assert.equal(f.ops.filter(o => o[0] === 'remove').length, 0);
  pass('keeper 探不到 SDK 时先重载，而不是继续原样复用');

  await f.health(owner.id, 'sdk-missing');              // 重载后仍坏：换一张
  assert.deepEqual(f.ops.filter(o => o[0] === 'remove'), [['remove', owner.id]]);
  assert.equal(f.tabs.find(t => t.id === owner.id), undefined);
  pass('重载后仍无 SDK 就关掉这张 keeper');

  const fresh = await f.ensure();                       // 下一轮应新建，而不是复活旧 id
  assert.notEqual(fresh.id, owner.id);
  pass('回收后下一轮会新建一张干净的 keeper');
}

// 恢复正常要清零计数，否则偶发一次失败会在很久以后凑成第二次、误杀好页面
{
  const f = fixture();
  const owner = await f.ensure();
  await f.health(owner.id, 'sdk-missing');
  await f.health(owner.id, 'ready');
  f.ops.length = 0;
  await f.health(owner.id, 'sdk-missing');
  assert.deepEqual(f.ops.filter(o => o[0] === 'reload'), [['reload', owner.id]]);
  assert.equal(f.ops.filter(o => o[0] === 'remove').length, 0);
  pass('中间恢复过一次就清零计数，不会把偶发失败累积成误杀');
}

// signed-out / not-ready 是正常状态，换页也解决不了，绝不能拿来churn标签
{
  const f = fixture();
  const owner = await f.ensure();
  f.ops.length = 0;
  for (const status of ['signed-out', 'not-ready', 'signed-out', 'not-ready']) await f.health(owner.id, status);
  assert.equal(f.ops.filter(o => o[0] === 'reload' || o[0] === 'remove').length, 0);
  pass('未登录/加载中不回收 keeper（换页也没用，只会反复开标签）');
}

// 用户自己打开的 FOMO 页不是我们的 keeper，坏了也不许碰
{
  const f = fixture([{ id: 7, url: appUrl, pinned: false }]);
  f.ops.length = 0;
  await f.health(7, 'sdk-missing');
  await f.health(7, 'sdk-missing');
  assert.equal(f.ops.filter(o => o[0] === 'reload' || o[0] === 'remove').length, 0);
  assert.ok(f.tabs.find(t => t.id === 7));
  pass('只回收自己开的 keeper，绝不重载或关闭用户自己的 FOMO 页');
}
