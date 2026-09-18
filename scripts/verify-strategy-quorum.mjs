// Offline strategy engine + real shared editor + background persistence. No real user data or APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const source = read('buy-strategies.js'), ctx = {}; vm.runInNewContext(source, ctx);
const S = ctx.GdhBuyStrategies, clone = x => JSON.parse(JSON.stringify(x));
const wallets = ['1','2','3','4','5'].map((n, i) => ({ address: '0x' + n.repeat(40), label: ['学长','Alice','Alice','测试四','未买入五'][i] }));
const token = '0x' + 'a'.repeat(40), outside = '0x' + 'f'.repeat(40);
let now = 1800000000000, seq = 0, checks = 0;
const pass = name => console.log(`PASS ${++checks}: ${name}`);
const config = (n = 3) => ({ group: { enabled: true, mode: 'atLeast', minBuyers: n, wallets, windowSeconds: 60 } });
const engine = raw => { const e = S.create(() => now); e.configure(raw || config()); return e; };
const buy = (i, extra = {}) => ({ wallet: wallets[i].address, token, chain: 'arc', side: 'buy', ts: now, tx: 't' + ++seq, href: `/arc/token/${token}`, ...extra });
{
  const e = engine(), a = buy(0);
  assert.equal(e.ingest([a, buy(0), buy(1), buy(4, { wallet: outside })]).length, 0);
  assert.equal(e.ingest([a]).length, 0);
  const result = e.ingest([buy(2)]); assert.equal(result.length, 1);
  assert.match(result[0].record.detail, /指定 5 人中至少 3 人，已买 3 人/);
  assert.ok(!result[0].record.detail.includes('未买入五'));
  assert.equal(e.ingest([a, buy(3), buy(4)]).length, 0);
  assert.equal(e.ingest([buy(0)]).length, 1);
  pass('5 人选 3 人，外部人物与重复买入不凑数，只展示实际买家；新一轮需要新的 3 人买入');
}
{
  const e = engine(); e.ingest([buy(0), buy(1)]);
  assert.equal(e.ingest([buy(2, { chain: 'eth' }), buy(2, { token: outside }), buy(2, { side: 'sell' })]).length, 0);
  now += 61000; assert.equal(e.ingest([buy(2)]).length, 0);
  assert.equal(e.ingest([buy(0), buy(1)]).length, 1);
  const legacy = config(); delete legacy.group.mode; delete legacy.group.minBuyers;
  const all = engine(legacy); assert.equal(all.ingest([buy(0), buy(1), buy(2), buy(3)]).length, 0);
  assert.equal(all.ingest([buy(4)]).length, 1);
  const one = engine(config(1)); assert.equal(one.ingest([buy(0)]).length, 1);
  for (const count of [0, -1, 1.5, 6, 21]) assert.equal(S.enabled(config(count)), false);
  pass('跨链、跨币、卖出和超时隔离；旧策略仍要求全部人；X=1 可用，无效阈值不启动');
}
{
  assert.equal(S.searchWallets(wallets, '学长')[0].address, wallets[0].address);
  assert.equal(S.searchWallets(wallets, 'ALICE').length, 2);
  assert.equal(S.searchWallets(wallets, wallets[0].address.toUpperCase())[0].address, wallets[0].address);
  assert.equal(S.searchWallets(wallets, '学长', [wallets[0]]).length, 0);
  assert.equal(S.searchWallets(wallets, outside)[0].address, outside);
  assert.equal(S.searchWallets(wallets, '不存在的备注').length, 0);
  const sol = 'A'.repeat(32); assert.equal(S.searchWallets([], sol)[0].address, sol);
  pass('备注与地址片段搜索，同名不同地址不合并，已选人物去重，未知完整地址可添加，Solana 大小写保留');
}

const stored = { priorityBuyStrategies: { version: 2, groups: [] } }; let listener;
const get = async keys => typeof keys === 'string' ? { [keys]: clone(stored[keys] ?? null) }
  : Object.fromEntries(Object.entries(keys).map(([k,v]) => [k, clone(stored[k] ?? v)]));
const set = async value => Object.assign(stored, clone(value));
vm.runInNewContext(source, { URL, chrome: { runtime: { id: 'fixture', onMessage: { addListener: fn => { listener = fn; } } }, storage: { local: { get, set } } } });
const send = msg => new Promise(resolve => listener(msg, { id: 'fixture', url: 'https://gmgn.ai/test' }, resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 750, height: 1100 } }); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main id="editor" style="width:440px;background:#16181d;color:#eee"></main>' }));
  await page.goto('https://gmgn.ai/test');
  await page.exposeFunction('send', send); await page.exposeFunction('get', get); await page.exposeFunction('set', set);
  await page.evaluate(() => { window.chrome = { runtime: { sendMessage: send }, storage: { local: { get, set } } }; });
  await page.addStyleTag({ content: read('styles.css') }); await page.addScriptTag({ content: source });
  await page.evaluate(wallets => { window.people = wallets; window.editor = GdhBuyStrategies.createEditor(document.querySelector('#editor'), { groups: [] }, wallets); }, wallets);
  const field = key => page.locator(`[data-buy="${key}"]`);
  assert.equal(await page.locator('.gdh-strategy-language').inputValue(), 'en');
  await page.getByRole('button', { name: '+ Add strategy', exact: true }).click();
  await field('name').fill('Quorum fixture'); await field('group-enabled').check();
  await field('group-mode').selectOption('atLeast'); assert.ok(await field('group-minBuyers').isVisible());
  await field('group-minBuyers').fill('3');
  await field('group-search').fill('学长');
  assert.equal(await field('group-picker').locator('option').count(), 2);
  await field('group-picker').selectOption({ index: 1 });
  assert.equal(await field('group-picker').locator('option').count(), 1);
  await field('group-search').fill('alice'); assert.equal(await field('group-picker').locator('option').count(), 3);
  await field('group-picker').selectOption({ index: 1 }); await field('group-picker').selectOption({ index: 1 });
  assert.equal((await field('group-wallets').inputValue()).split('\n').length, 3);
  await field('group-search').fill(outside); await field('group-picker').selectOption({ index: 1 });
  assert.ok((await field('group-wallets').inputValue()).includes(outside));
  await page.getByRole('button', { name: 'Save strategy', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('Strategy saved'));
  assert.equal(stored.priorityBuyStrategies.groups[0].conditions.group.mode, 'atLeast');
  assert.equal(stored.priorityBuyStrategies.groups[0].conditions.group.minBuyers, 3);
  assert.equal(stored.priorityBuyStrategies.groups[0].enabled, false);
  assert.ok(!JSON.stringify(stored.priorityBuyStrategies).includes('search'));
  await page.locator('#editor').screenshot({ path: new URL('../dist/strategy-quorum-en-v93.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
  await field('group-search').fill('no match');
  assert.ok(!(await page.locator('.gdh-strategy-group button').innerText()).includes('Unsaved'));
  pass('默认英文界面可按备注挑选同名多人、手输新地址；X 与模式保存，搜索不写入策略也不弄脏草稿');

  await page.locator('.gdh-strategy-language').selectOption('zh');
  assert.equal(await page.getByRole('button', { name: '保存本组', exact: true }).count(), 1);
  assert.equal(await field('group-minBuyers').inputValue(), '3');
  await field('group-minBuyers').fill('5'); await page.getByRole('button', { name: '保存本组', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('不能大于'));
  assert.equal(stored.priorityBuyStrategies.groups[0].conditions.group.minBuyers, 3);
  await field('group-minBuyers').fill('2'); await page.getByRole('button', { name: '+ 新增策略', exact: true }).click();
  await page.locator('.gdh-strategy-group button').first().click(); assert.equal(await field('group-minBuyers').inputValue(), '2');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-buy=group-minBuyers]').value === '3');
  assert.equal(await field('group-mode').inputValue(), 'atLeast');
  const group = clone(stored.priorityBuyStrategies.groups[0]);
  for (const n of [0, 1.5, 5, 21]) {
    const bad = clone(group); bad.conditions.group.minBuyers = n;
    const response = await send({ type: 'buy-strategy-update', action: 'save', id: group.id, expected: JSON.stringify(group), group: bad });
    assert.equal(response.ok, false); assert.equal(stored.priorityBuyStrategies.groups[0].conditions.group.minBuyers, 3);
  }
  pass('中文切换保留草稿，切组和重新读取恢复 X；前后台都拒绝小数、越界及超过去重人数的阈值');
  await page.locator('.gdh-strategy-group input').first().check();
  await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('开关已保存'));
  assert.equal(stored.priorityBuyStrategies.groups[0].enabled, true);
  const e = engine(stored.priorityBuyStrategies); assert.equal(e.ingest([buy(0), buy(1)]).length, 0); assert.equal(e.ingest([buy(2)]).length, 1);
  await field('group-search').fill('新备注');
  await page.evaluate(async () => { people[4].label = '新备注'; editor.sync((await chrome.storage.local.get('priorityBuyStrategies')).priorityBuyStrategies, people); });
  assert.equal(await field('group-search').inputValue(), '新备注');
  assert.equal(await field('group-picker').locator('option').count(), 2);
  assert.deepEqual(errors, []);
  await page.locator('#editor').screenshot({ path: new URL('../dist/strategy-quorum-v93.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
  assert.equal(stored.priorityStrategyLanguageV1, 'zh');
  await page.evaluate(async () => {
    const host = document.createElement('div'); host.id = 'reopened'; document.body.append(host);
    GdhBuyStrategies.createEditor(host, (await chrome.storage.local.get('priorityBuyStrategies')).priorityBuyStrategies, people);
  });
  await page.waitForFunction(() => document.querySelector('#reopened .gdh-strategy-language').value === 'zh');
  assert.equal(await page.locator('#reopened [data-buy=group-minBuyers]').inputValue(), '3');
  pass('保存后的策略实际按 X 人触发；搜索结果随本地备注更新，语言选择单独保存，无页面异常');
} finally { await browser.close(); }
console.log(`1..${checks}`);
