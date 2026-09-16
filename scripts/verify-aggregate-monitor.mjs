import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../aggregate-monitor.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(code, { module, URL });
const { create, normalize } = module.exports;
const NOW = 1_789_500_000_000;
const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), T = '0x' + '1'.repeat(40);
const buy = (changes = {}) => ({ source: 'gmgn', chain: 'bsc', wallet: A, addr: T, type: 'buy',
  name: '学长', symbol: '测试币', ts: NOW - 1000, tx: '0x111', usd: 100, mc: 10000, ...changes });
let checks = 0;
const test = (name, run) => { run(); console.log(`PASS ${++checks}: ${name}`); };
const rows = (engine, filters = {}, now = NOW) => engine.snapshot({ minBuyers: 1, ...filters }, now).rows;
test('仅接受有效身份、合约和实际买卖时间；不以展示名猜买家', () => {
  assert.ok(normalize(buy(), NOW));
  for (const raw of [buy({ wallet: '', source: 'fomo', handle: '' }), buy({ ts: NOW + 60000 }), buy({ ts: NOW - 86400001 }), buy({ addr: 'fake' }), buy({ type: 'refund' })]) assert.equal(normalize(raw, NOW), null);
  assert.equal(normalize(buy({ ts: (NOW - 1000) / 1000 }), NOW).ts, NOW - 1000);
});
test('同一人多次买入只计一人，金额累加；重复轮询不累加', () => {
  const e = create(), input = [buy(), buy({ tx: '0x222', usd: 200 }), buy({ wallet: B, tx: '0x333', usd: 300 })];
  e.ingest(input, NOW); e.ingest(input, NOW);
  const r = rows(e)[0]; assert.equal(r.buyerCount, 2); assert.equal(r.buyCount, 3); assert.equal(r.buyUsd, 600);
});
test('同链同交易 GMGN/Pump 合并；FOMO exact tx 关联钱包后去重', () => {
  const e = create(); e.ingest([buy(), buy({ source: 'pump', name: '泵用户' }), buy({ source: 'fomo', wallet: '', handle: 'userA' }), buy({ source: 'fomo', wallet: '', handle: 'userA', tx: '0x222', usd: 150 })], NOW);
  const r = rows(e)[0]; assert.equal(r.buyerCount, 1); assert.equal(r.buyCount, 2); assert.equal(r.buyUsd, 250);
  assert.equal(r.sources.length, 3);
});
test('不同 hash、相近时间金额不误合并；FOMO 同昵称不同账号仍分别计人', () => {
  const e = create(); e.ingest([buy(), buy({ source: 'fomo', wallet: '', handle: 'alice', tx: '0x222' }), buy({ source: 'fomo', wallet: '', handle: 'bob', tx: '0x333' })], NOW);
  assert.equal(rows(e)[0].buyerCount, 3); assert.equal(rows(e)[0].buyUsd, 300);
});
test('同一 tx 多个钱包时不能猜 FOMO 身份', () => {
  const e = create(); e.ingest([buy(), buy({ wallet: B }), buy({ source: 'fomo', wallet: '', handle: 'alice' })], NOW);
  assert.equal(rows(e)[0].buyerCount, 3);
});
test('无 tx、不同来源事件 key 不冒险吞掉不同买入', () => {
  const e = create(); e.ingest([buy({ tx: '', key: 'one' }), buy({ tx: '', key: 'two' })], NOW);
  assert.equal(rows(e)[0].buyCount, 2); assert.equal(rows(e)[0].buyUsd, 200);
});
test('同名跨链 / 跨合约不混组，EVM 大小写一致', () => {
  const e = create(); e.ingest([buy(), buy({ chain: 'base' }), buy({ addr: C }), buy({ wallet: A.toUpperCase().replace('0X', '0x') })], NOW);
  assert.equal(rows(e).length, 3); assert.equal(rows(e).reduce((n, r) => n + r.buyUsd, 0), 300);
});
test('SOL 钱包与合约大小写敏感', () => {
  const token = 'Ab' + '1'.repeat(30), other = 'ab' + '1'.repeat(30);
  const e = create(); e.ingest([buy({ chain: 'sol', addr: token }), buy({ chain: 'sol', addr: other })], NOW);
  assert.equal(rows(e).length, 2);
});
test('卖出不增加买入人数，不把买入额改成净流入', () => {
  const e = create(); e.ingest([buy(), buy({ type: 'sell', wallet: B, tx: '0x222', usd: 60 })], NOW);
  const r = rows(e)[0]; assert.equal(r.buyerCount, 1); assert.equal(r.buyUsd, 100); assert.equal(r.sellUsd, 60);
});
test('人数 / USD / 链 / 时间窗筛选和金额 / 人数排序', () => {
  const e = create(); e.ingest([buy(), buy({ wallet: B, tx: '0x222' }), buy({ addr: C, usd: 900 }), buy({ addr: B, ts: NOW - 600000 })], NOW);
  assert.equal(rows(e, { minBuyers: 2 }).length, 1);
  assert.equal(rows(e, { minUsd: 500 })[0].token, C);
  assert.equal(rows(e, { sort: 'buyUsd' })[0].token, C);
  assert.equal(rows(e, { sort: 'buyerCount' })[0].token, T);
  assert.equal(rows(e, { chain: 'sol' }).length, 0);
  assert.equal(rows(e, { windowMs: 900000 }).length, 3);
});
test('未知买入金额单独标记，不能编造为实际 0 美元', () => {
  const e = create(); e.ingest([buy({ usd: NaN })], NOW);
  assert.equal(rows(e)[0].unknownAmounts, 1); assert.equal(rows(e, { minUsd: 1 }).length, 0);
});
test('最新市值优先，过时数据和空图 / 0 MC 不覆盖已知元数据', () => {
  const e = create(); e.ingest([buy({ ts: NOW - 1000, mc: 20000, img: 'https://gmgn.ai/img.webp' }), buy({ tx: '0x222', ts: NOW - 5000, mc: 9000 })], NOW);
  e.ingest([buy({ mc: 0, img: '' })], NOW);
  const r = rows(e)[0]; assert.equal(r.mc, 20000); assert.equal(r.img, 'https://gmgn.ai/img.webp');
});
test('过期缓存移除，来源关闭可立即剔除', () => {
  const e = create(); e.ingest([buy(), buy({ source: 'pump', tx: '0x222', wallet: B })], NOW);
  e.removeSource('pump'); assert.equal(rows(e)[0].buyerCount, 1);
  assert.equal(rows(e, {}, NOW + 86400000).length, 0);
});
test('高流量有界缓存，保留最新 20,000 条并标示截断', () => {
  const e = create();
  for (let b = 0; b < 9; b++) e.ingest(Array.from({ length: 2500 }, (_, i) => buy({ tx: `tx-${b * 2500 + i}`, ts: NOW - 30000 + b * 2500 + i })), NOW);
  const r = e.snapshot({ minBuyers: 1 }, NOW);
  assert.equal(r.events, 20000); assert.equal(r.capped, true); assert.equal(r.rows[0].buyCount, 20000);
});
test('头像跟随去重买家，跨来源补头像，缺失和危险 URL 不冒充代币头像', () => {
  const e = create(); e.ingest([buy(), buy({ source: 'pump', avatar: 'https://gmgn.ai/person.png' }), buy({ wallet: B, tx: '0x222', avatar: 'javascript:alert(1)' })], NOW);
  const people = rows(e)[0].buyers;
  assert.equal(people.length, 2);
  assert.equal(people.find(p => p.id.endsWith(A)).avatar, 'https://gmgn.ai/person.png');
  assert.equal(people.find(p => p.id.endsWith(B)).avatar, '');
  e.ingest([buy({ tx: '0x333', ts: NOW - 500, avatar: 'https://gmgn.ai/new-person.png' })], NOW);
  assert.equal(rows(e)[0].buyers.find(p => p.id.endsWith(A)).avatar, 'https://gmgn.ai/new-person.png');
});
test('地址占位可被昵称补全，空快照不能抹掉昵称，跨来源补全不重复计数', () => {
  const e = create(); e.ingest([buy({ name: '' })], NOW);
  assert.equal(rows(e)[0].buyers[0].name, A);
  e.ingest([buy({ source: 'pump', name: '后来补上的昵称' })], NOW);
  assert.equal(rows(e)[0].buyers[0].name, '后来补上的昵称');
  assert.equal(rows(e)[0].buyerCount, 1); assert.equal(rows(e)[0].buyUsd, 100);
  e.ingest([buy({ name: '公开昵称' }), buy({ name: '' })], NOW);
  assert.notEqual(rows(e)[0].buyers[0].name, A);
  e.ingest([buy({ name: '最新昵称', tx: '0x222', ts: NOW - 500 })], NOW);
  assert.equal(rows(e)[0].buyers[0].name, '最新昵称');
});

test('运行清单、NEW 文案、本地发布边界、禁止新 fetch / 交易入口', () => {
  const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const m = JSON.parse(read('manifest.json'));
  assert.ok(m.content_scripts.find(s => s.world === 'MAIN' && s.matches.includes('https://gmgn.ai/*')).js.includes('aggregate-monitor.js'));
  assert.ok(m.content_scripts.some(s => s.css?.includes('aggregate-monitor.css')));
  assert.ok(read('scripts/build-release.ps1').includes("'aggregate-monitor.js'"));
  assert.ok(read('popup.html').includes('聚合监控 <em class="new-badge">NEW'));
  assert.ok(read('CHANGELOG.md').includes('本地试用，未发布'));
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendTransaction|eth_sendTransaction/.test(code));
  assert.ok(code.includes("visible: false, type: 'modal'"));
  assert.ok(code.includes('data-gdh-nav-spa-only'));
  assert.ok(code.includes("db.transaction('app_state', 'readonly')"));
});
console.log(`aggregate monitor: ${checks} checks passed`);
