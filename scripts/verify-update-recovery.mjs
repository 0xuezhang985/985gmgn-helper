// Offline Native Messaging fixtures: no real processes, network or user storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('function sendNativeMessage('), source.indexOf('chrome.runtime.onInstalled.addListener('));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(mode = 'ok') {
  const data = { enableFomoFeed: false, enableFomoPanel: false, enableFomoTrending: false, specialWallets: ['preserved'] };
  const timers = new Map(), calls = [], ports = [];
  let tick = 0, nextId = 0;
  const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)), get size() { return listeners.size; } }; };
  const h = { mode, data, timers, calls, ports, storageFails: false };
  const response = () => ({ ok: true, latestVersion: '0.46.126', updateAvailable: true, protocolVersion: 2, summary: '更新检查恢复测试' });
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.46.125' }), getURL: name => 'chrome-extension://fixture/' + name,
      sendNativeMessage: (_host, message, cb) => {
        calls.push({ transport: 'legacy', ...message });
        if (h.mode !== 'hang') queueMicrotask(() => cb(response()));
      },
      connectNative: () => {
        if (h.mode === 'throw') throw new Error('Native host launch failed');
        const port = { onMessage: event(), onDisconnect: event(), disconnected: 0,
          disconnect() { this.disconnected++; this.onDisconnect.emit(); },
          postMessage(message) {
            calls.push({ transport: 'port', ...message });
            if (h.mode === 'post-throw') throw new Error('Attempting to use a disconnected port object');
            if (h.mode === 'hang') return;
            queueMicrotask(() => {
              if (h.mode === 'missing' || h.mode === 'disconnect') {
                chrome.runtime.lastError = { message: h.mode === 'missing' ? 'Specified native messaging host not found.' : 'Native host has exited.' };
                this.onDisconnect.emit(); delete chrome.runtime.lastError;
              } else this.onMessage.emit(h.mode === 'invalid' ? null : h.mode === 'remote-error' ? { ok: false, error: '更新源返回 HTTP 503' } : response());
            });
          },
        }; ports.push(port); return port;
      },
    },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]])),
      set: async value => { if (h.storageFails) throw new Error('storage unavailable'); Object.assign(data, value); },
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  h.ctx = vm.createContext({ chrome, NATIVE_HOST: 'fixture', RELEASES_URL: 'https://github.com/0xuezhang985/985gmgn-helper/releases/latest', Date, AbortController,
    fetch: async () => { throw new Error('unexpected network'); },
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: tick + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  h.advance = async ms => { tick += ms; for (const [id, t] of timers) if (t.at <= tick) { timers.delete(id); t.fn(); } await flush(); };
  vm.runInContext(section, h.ctx);
  return h;
}
let n = 0;
const pass = name => console.log(`PASS ${++n}: ${name}`);

{
  const h = fixture('hang'); let result;
  const first = h.ctx.checkForUpdate().then(r => { result = r; });
  await h.advance(20000);
  assert.ok(result, 'hung check must settle after its deadline instead of locking all retries');
  await first;
  assert.equal(result.status, 'error'); assert.match(result.error, /超时/);
  assert.equal(h.ports[0].disconnected, 1); assert.equal(h.timers.size, 0);
  assert.equal(h.ports[0].onMessage.size + h.ports[0].onDisconnect.size, 0);
  h.ports[0].onMessage.emit({ ok: true, latestVersion: '99.0.0' });
  assert.equal(h.data.updateState.status, 'error');
  h.mode = 'ok'; const recovered = await h.ctx.checkForUpdate();
  assert.equal(recovered.status, 'available'); assert.equal(h.calls.length, 2);
  assert.equal(h.data.enableFomoFeed, false); assert.equal(h.data.enableFomoPanel, false); assert.equal(h.data.enableFomoTrending, false);
  assert.deepEqual(h.data.specialWallets, ['preserved']);
  pass('超时释放连接与检查锁，忽略迟到消息，手动重试恢复且不修改功能设置');
}
{
  const h = fixture(); const [a, b] = await Promise.all([h.ctx.checkForUpdate(), h.ctx.checkForUpdate()]);
  assert.equal(h.calls.length, 1); assert.equal(a, b); assert.equal(a.updaterInstalled, true);
  assert.equal(h.ports[0].disconnected, 1); assert.equal(h.timers.size, 0);
  pass('正常检查合并并发请求，返回后关闭临时端口');
}
for (const [mode, expected] of [['missing', 'updater_missing'], ['disconnect', 'error'], ['throw', 'error'], ['post-throw', 'error'], ['invalid', 'error'], ['remote-error', 'error']]) {
  const h = fixture(mode); const state = await h.ctx.checkForUpdate();
  assert.equal(state.status, expected, mode); assert.equal(h.timers.size, 0, mode);
  if (mode === 'missing') assert.equal(state.updaterInstalled, false);
  if (h.ports.length) assert.equal(h.ports[0].disconnected, 1);
  pass(`${mode} 正确分类，只有明确找不到更新器才提示未安装`);
}
{
  const h = fixture(); h.storageFails = true;
  const state = await h.ctx.checkForUpdate(); assert.equal(state.status, 'error'); assert.match(state.error, /storage/);
  h.storageFails = false; assert.equal((await h.ctx.checkForUpdate()).status, 'available');
  pass('存储失败仍返回错误响应并释放检查锁');
}
{
  const h = fixture('hang'); let history;
  h.ctx.sendNativeMessage({ action: 'history' }).catch(e => { history = e; });
  await h.advance(30000); assert.match(history.message, /超时/); assert.equal(h.ports[0].disconnected, 1);
  h.mode = 'ok'; await h.ctx.sendNativeMessage({ action: 'update', version: '0.46.126' });
  await h.ctx.sendNativeMessage({ action: 'rollback', version: '0.46.124' });
  assert.deepEqual(h.calls.slice(-2).map(c => c.transport), ['legacy', 'legacy']);
  pass('历史读取有时限，安装和回退不被只读请求超时逻辑中断');
}
console.log(`1..${n}`);
