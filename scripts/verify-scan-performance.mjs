import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(process.env.GDH_BRIDGE_SOURCE || new URL('../page-bridge.js', import.meta.url), 'utf8');
function fixture() {
  let now = 0, id = 0, observer;
  const tasks = new Map(), listeners = {}, scans = [];
  class Element {
    constructor(owner = '') { this.owner = owner; }
    closest(selector) { return this.owner && selector.split(',').map(x => x.trim()).includes(this.owner) ? this : null; }
  }
  const timer = (fn, delay) => { const key = ++id; tasks.set(key, { fn, at: now + delay }); return key; };
  const document = { visibilityState: 'visible', documentElement: new Element(), addEventListener: (name, fn) => { listeners[name] = fn; } };
  const ctx = vm.createContext({ document, Element, Date: { now: () => now }, Math,
    scanScheduled: false, scanRafId: 0, scanDelayTimer: 0, scrollingUntil: 0, lastScanAt: -Infinity, SCAN_INTERVAL_MS: 200,
    scanCards: () => { ctx.scanScheduled = false; scans.push(now); },
    window: { requestAnimationFrame: fn => timer(fn, 16), setTimeout: timer, setInterval() {} },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
  });
  const start = source.indexOf('  function runScheduledScan()');
  const end = source.indexOf("  else document.addEventListener('DOMContentLoaded', startDomScanner, { once: true });", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, source.indexOf('\n', end)), ctx);
  function advance(to) {
    while (true) {
      const next = [...tasks.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      tasks.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = to;
  }
  return { ctx, document, listeners, scans, tasks, advance, mutate: (owner = '') => observer([{ target: new Element(owner) }]) };
}
test('60Hz native mutations coalesce to five scans per second', () => {
  const h = fixture();
  for (let t = 0; t <= 1000; t += 16) { h.advance(t); h.mutate(); }
  h.advance(1200);
  assert.ok(h.scans.length >= 4 && h.scans.length <= 6, `scans=${h.scans.length}`);
  for (let i = 1; i < h.scans.length; i++) assert.ok(h.scans[i] - h.scans[i - 1] >= 200);
});
test('independent overlay changes are ignored; native parent changes still trigger scanning', () => {
  const h = fixture(); h.advance(20);
  for (const owner of ['.gdh-monitor-aggregate', '#gmgn-zf-switch', '#gmgn-zf-float', '#robin-signal-panel']) h.mutate(owner);
  h.advance(1000); assert.equal(h.scans.length, 1);
  h.mutate(); h.advance(1500); assert.equal(h.scans.length, 2);
});
test('pending frames pause while hidden and resume on visibility change', () => {
  const h = fixture(); h.document.visibilityState = 'hidden'; h.advance(50);
  assert.equal(h.scans.length, 0); assert.equal(h.ctx.scanScheduled, false);
  h.mutate(); assert.equal(h.tasks.size, 0);
  h.document.visibilityState = 'visible'; h.listeners.visibilitychange(); h.advance(100);
  assert.equal(h.scans.length, 1);
});
test('scroll deferral keeps one timer and scans after scrolling stops', () => {
  const h = fixture(); h.listeners.scroll(); h.advance(100);
  assert.equal(h.scans.length, 0); assert.equal(h.tasks.size, 1);
  h.listeners.scroll(); h.advance(250); assert.equal(h.scans.length, 0); assert.equal(h.tasks.size, 1);
  h.advance(350); assert.equal(h.scans.length, 1); assert.equal(h.tasks.size, 0);
});
