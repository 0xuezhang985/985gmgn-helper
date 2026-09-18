import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = read('aggregate-monitor.js'), module = { exports: {} };
vm.runInNewContext(code, { module, URL });
const { create, nativeEvent } = module.exports;
const NOW = 1789500000000, addr = n => '0x' + n.repeat(40), T = addr('1');
const buy = (patch = {}) => ({ source: 'gmgn', chain: 'bsc', wallet: addr('a'), addr: T, type: 'buy', ts: NOW - 3000,
  tx: '0x01', usd: 100, symbol: 'FLOW', name: 'Alice', ...patch });
const sell = (patch = {}) => buy({ type: 'sell', ts: NOW - 2000, tx: '0x02', usd: 90, closed: true, ...patch });
const snapshot = (engine, now = NOW) => engine.snapshot({ minBuyers: 1 }, now).rows[0];
let count = 0; const pass = text => console.log(`PASS ${++count}: ${text}`);
assert.equal(nativeEvent({ side: 'sell', is_open_or_close: 1 }).closed, true);
assert.equal(nativeEvent({ side: 'sell', is_open_or_close: 0 }).closed, false);
for (const hit of [{ side: 'buy', is_open_or_close: 1 }, { side: 'sell' }, { side: 'sell', is_open_or_close: -1 },
  { side: 'sell', is_open_or_close: '1' }, { side: 'sell', is_open_or_close: 1, chain: 'bsc', commitment: 'processed' }]) assert.equal(nativeEvent(hit).closed, null);
assert.equal(nativeEvent({ side: 'sell', is_open_or_close: 1, chain: 'bsc', commitment: 'confirm' }).closed, true);
pass('GMGN 线上实证字段：sell + 1 清仓、0 部分卖出，未知和 BSC processed 不冒充确认清仓');
const fixture = [buy(), buy({ wallet: addr('b'), name: 'Bob', tx: '0x03' }), buy({ wallet: addr('c'), name: 'Carol', tx: '0x04' }),
  sell(), sell({ wallet: addr('b'), name: 'Bob', tx: '0x05', usd: 40, closed: false }),
  sell({ wallet: addr('d'), name: 'Seller only', tx: '0x06', usd: 30 }),
  sell({ source: 'fomo', wallet: '', handle: 'alice', closed: undefined }), sell({ source: 'pump', closed: undefined })];
{
  const e = create(); e.ingest(fixture, NOW); e.ingest(fixture, NOW);
  const r = snapshot(e);
  assert.equal(r.buyUsd, 300); assert.equal(r.sellUsd, 160); assert.equal(r.netUsd, 140); assert.equal(r.netComplete, true);
  assert.equal(r.buyCount, 3); assert.equal(r.sellCount, 3); assert.equal(r.buyerCount, 3); assert.equal(r.sellerCount, 3);
  assert.equal(r.closedCount, 2); assert.equal(r.unknownCloseCount, 0); assert.equal(r.people.length, 4);
  assert.equal(r.people.find(p => p.name === 'Seller only').usd, 0);
  e.ingest([buy({ tx: '0x07', ts: NOW - 1000, usd: 20 })], NOW);
  assert.equal(snapshot(e).closedCount, 1); assert.equal(snapshot(e).netUsd, 160);
  e.ingest([sell({ tx: '0x08', ts: NOW - 2500 })], NOW);
  assert.equal(snapshot(e).closedCount, 1);
  pass('跨来源及重复快照交易去重；买/卖/净额、卖家与清仓人数正确，重买和乱序旧清仓不误标');
}
{
  const e = create(); e.ingest([buy(), sell({ usd: 300 })], NOW);
  assert.equal(snapshot(e).netUsd, -200); assert.equal(snapshot(e).closedCount, 1);
  e.ingest([sell({ tx: '0x08', ts: NOW - 1000, closed: undefined, usd: 0 })], NOW);
  assert.equal(snapshot(e).closedCount, 0); assert.equal(snapshot(e).unknownCloseCount, 1);
  assert.equal(snapshot(e).unknownSellAmounts, 1); assert.equal(snapshot(e).netComplete, false);
  assert.equal(snapshot(e).sellUsd, 300);
  e.ingest([sell({ tx: '0x08', ts: NOW - 1000, closed: false, usd: 20 })], NOW);
  assert.equal(snapshot(e).unknownCloseCount, 0); assert.equal(snapshot(e).closedCount, 0); assert.equal(snapshot(e).netComplete, true);
  pass('未知清仓/缺失卖出 USD 不伪装成零；后续明确数据补全，负净额不误当利润');
}
{
  const e = create(); e.ingest([buy(), sell()], NOW); e.ingest([sell({ closed: undefined })], NOW);
  assert.equal(snapshot(e).closedCount, 1);
  e.ingest([sell({ source: 'pump', closed: false })], NOW);
  assert.equal(snapshot(e).closedCount, 0); assert.equal(snapshot(e).unknownCloseCount, 1);
  const tied = create(); tied.ingest([buy(), sell({ ts: NOW - 3000 })], NOW);
  assert.equal(snapshot(tied).closedCount, 0); assert.equal(snapshot(tied).unknownCloseCount, 1);
  const unknown = create(); unknown.ingest([buy(), sell({ source: 'fomo', wallet: '', handle: 'alice', closed: undefined })], NOW);
  assert.equal(snapshot(unknown).closedCount, 0); assert.equal(snapshot(unknown).unknownCloseCount, 1);
  assert.equal(unknown.snapshot({ minBuyers: 1 }, NOW + 301000).rows.length, 0);
  pass('已知标记不被空快照抹掉；冲突、同秒无法排序和缺字段保持未知，窗口过期移除');
}
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 950, height: 800 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('https://gmgn.ai/bsc/token/' + T);
  await page.evaluate(now => { Date.now = () => now; window.setInterval = () => 1; localStorage.setItem('gdhBuyAggregateFiltersV1', JSON.stringify({ minBuyers: 1 })); }, NOW);
  await page.addStyleTag({ content: read('aggregate-monitor.css') + '.gdh-buy-monitor{width:340px;height:720px}' });
  const source = code.replace('  // Bounded, visible-page-only maintenance.', `
    window.testFlows = { mount(rows) { active=started=true;body=makeBody();document.body.appendChild(body);engine.ingest(rows);paint(true); },
      ingest(rows) {engine.ingest(rows);paint(true);} };
    // Bounded, visible-page-only maintenance.`);
  await page.addScriptTag({ content: source });
  const negative = [buy({ addr: addr('2'), symbol: 'NEGATIVE', tx: '0x20' }), sell({ addr: addr('2'), symbol: 'NEGATIVE', tx: '0x21', usd: 300 })];
  const missing = [buy({ addr: addr('3'), symbol: 'UNKNOWN', tx: '0x30' }), sell({ addr: addr('3'), symbol: 'UNKNOWN', tx: '0x31', usd: 0, closed: undefined })];
  await page.evaluate(rows => testFlows.mount(rows), [...fixture, ...negative, ...missing]);
  const card = symbol => page.locator('.gdh-buy-list article').filter({ has: page.locator('.gdh-buy-row strong', { hasText: symbol }) });
  assert.equal(await card('FLOW').locator('[data-flow=sell]').innerText(), '$160.00');
  assert.equal(await card('FLOW').locator('[data-flow=net]').innerText(), '+$140.00');
  assert.equal(await card('FLOW').locator('[data-flow=closed]').innerText(), '2');
  assert.equal(await card('NEGATIVE').locator('[data-flow=net]').innerText(), '-$200.00');
  assert.equal(await card('UNKNOWN').locator('[data-flow=net]').innerText(), '—');
  assert.equal(await card('UNKNOWN').locator('[data-flow=closed]').innerText(), '—');
  assert.match(await card('UNKNOWN').locator('.gdh-buy-flow').innerText(), /Net buy/);
  await card('FLOW').locator('.gdh-buy-flow button').click();
  assert.equal(await card('FLOW').locator('.gdh-buy-person-detail').count(), 4);
  assert.ok((await card('FLOW').locator('.gdh-buy-people').innerText()).includes('Seller only'));
  assert.ok((await card('FLOW').locator('.gdh-buy-people').innerText()).includes('Closed'));
  pass('生产卡片显示卖出/净买入/清仓，未知用破折号；点击清仓能查看卖出者与买卖明细');
  await page.locator('.gdh-buy-alerts > summary').click(); await page.locator('[data-alert-language]').selectOption('zh');
  await page.locator('.gdh-buy-alerts > summary').click();
  assert.match(await card('FLOW').locator('.gdh-buy-flow').innerText(), /净买入/);
  assert.match(await card('UNKNOWN').locator('.gdh-buy-flow button').getAttribute('title'), /状态未知 1 人/);
  await page.evaluate(rows => testFlows.ingest(rows), [buy({ tx: '0x09', ts: NOW - 500, usd: 30 })]);
  assert.equal(await card('FLOW').locator('[data-flow=closed]').innerText(), '1');
  assert.equal(await card('FLOW').locator('[data-flow=net]').innerText(), '+$170.00');
  assert.equal(await page.locator('.gdh-buy-list').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.equal(await card('NEGATIVE').locator('[data-flow=net]').evaluate(el => getComputedStyle(el).color), 'rgb(237, 98, 110)');
  await page.locator('.gdh-buy-monitor').screenshot({ path: 'dist/aggregate-flows-v96.png' });
  await page.evaluate(() => document.documentElement.classList.add('light'));
  assert.equal(await card('NEGATIVE').locator('[data-flow=net]').evaluate(el => getComputedStyle(el).color), 'rgb(187, 38, 56)');
  await page.locator('.gdh-buy-monitor').screenshot({ path: 'dist/aggregate-flows-light-v96.png' });
  assert.deepEqual(errors, []);
  pass('中文切换与实时补充事件更新统计；340px 深浅主题无横溢出，正负颜色正确，无脚本异常');
} finally { await browser.close(); }
console.log(`Verified ${count} sell / net flow / closed-position checks.`);
