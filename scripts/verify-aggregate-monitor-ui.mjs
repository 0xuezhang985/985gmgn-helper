// Offline browser fixtures run the production renderer; no real trades, login state or APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = read('aggregate-monitor.js').replace('  // Bounded, visible-page-only maintenance.', `
  window.testAggregate = {
    mount(rows) { active = started = true; body = makeBody(); document.body.appendChild(body); engine.ingest(rows); revision++; paint(true); },
    ingest(rows) { engine.ingest(rows); revision++; paint(true); },
    paint() { paint(true); },
    async refreshMarks() { while (marksReading) await new Promise(r => setTimeout(r, 10)); await refreshWalletMarks(true); paint(true); },
    rowCount() { return engine.snapshot(filters).rows.length; },
  };
  // Bounded, visible-page-only maintenance.`);
const browser = await chromium.launch({ headless: true });
let n = 0; const pass = text => console.log(`PASS ${++n}: ${text}`);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"></head><body><div id="original">原生追踪保持不变</div></body></html>' }));
  await page.goto('https://gmgn.ai/bsc/token/0x' + 'f'.repeat(40));
  const setup = async () => {
    await page.addStyleTag({ content: read('aggregate-monitor.css') + '.gdh-buy-monitor{width:360px;height:540px}' });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const now = Date.now();
      const trade = (i, patch = {}) => ({ source: 'gmgn', type: 'buy', chain: 'bsc', addr: '0x' + '1'.repeat(40),
        wallet: '0x' + String(i).repeat(40), tx: '0x' + i, ts: now - i * 1000, usd: 100, symbol: '多人买入', mc: 15000, name: `人物${i}`, ...patch });
      window.fixture = [trade(2), trade(3), trade(4), trade(2, { source: 'pump', avatar: 'https://gmgn.ai/person-2.png' }), trade(2, { source: 'fomo', wallet: '', handle: 'alice' }),
        trade(5, { addr: '0x' + '9'.repeat(40), usd: 1000, symbol: '<img src=x onerror="window.xss=true">' }),
        trade(6, { addr: '0x' + '9'.repeat(40), usd: 1000, symbol: '<img src=x onerror="window.xss=true">' })];
      testAggregate.mount(fixture);
    });
  };
  await setup();
  const stripe = () => page.locator('.gdh-buy-list article').first().evaluate(el => {
    const css = getComputedStyle(el, '::before');
    return { color: css.backgroundColor, width: css.width, left: css.left, top: css.top,
      bottom: css.bottom, position: css.position, pointerEvents: css.pointerEvents,
      anchor: getComputedStyle(el).position, overflow: el.scrollWidth > el.clientWidth };
  });
  assert.deepEqual(await stripe(), { color: 'rgb(234, 178, 4)', width: '3px', left: '0px', top: '0px',
    bottom: '0px', position: 'absolute', pointerEvents: 'none', anchor: 'relative', overflow: false });
  await page.evaluate(() => {
    localStorage.setItem('follow_toast_chain_color_v1', JSON.stringify({ bsc: { color: '#e0528d' } }));
    testAggregate.paint();
  });
  assert.equal((await stripe()).color, 'rgb(224, 82, 141)');
  for (const bad of ['not-json', JSON.stringify({ bsc: { color: 'red;position:fixed' } })]) {
    await page.evaluate(value => { localStorage.setItem('follow_toast_chain_color_v1', value); testAggregate.paint(); }, bad);
    assert.equal((await stripe()).color, 'rgb(234, 178, 4)');
  }
  await page.evaluate(() => { localStorage.removeItem('follow_toast_chain_color_v1'); testAggregate.paint(); });
  pass('卡片最左侧 3px 链色细条不占内容宽度、不挡点击；自定义颜色实时生效，异常配置安全回退');
  assert.equal(await page.locator('.gdh-buy-list article').count(), 2);
  assert.equal(await page.locator('.gdh-buy-count').first().innerText(), '♙ 3');
  assert.ok((await page.locator('.gdh-buy-meta').first().innerText()).includes('PUMP'));
  assert.equal(await page.evaluate(() => window.xss), undefined);
  assert.equal(await page.locator('.gdh-buy-row a img').count(), 0);
  assert.equal(await page.locator('.gdh-buy-avatars').first().locator('.gdh-buy-person').count(), 3);
  assert.equal(await page.locator('.gdh-buy-person img').count(), 1);
  const position = await page.locator('.gdh-buy-row').first().evaluate(row => ({
    avatarsRight: row.querySelector('.gdh-buy-avatars').getBoundingClientRect().right,
    countLeft: row.querySelector('.gdh-buy-count').getBoundingClientRect().left,
  }));
  assert.ok(position.avatarsRight <= position.countLeft);
  pass('三来源真实渲染函数按人数聚合，同笔买入不重复；不执行币名中的 HTML');
  await page.locator('.gdh-buy-avatars').first().click();
  assert.equal(await page.locator('.gdh-buy-people div').count(), 3);
  assert.equal(await page.locator('.gdh-buy-people b').first().innerText(), '$100.00');
  pass('展开去重买家明细并显示来源 / 买入金额');
  await page.locator('.gdh-buy-person img').dispatchEvent('error');
  assert.equal(await page.locator('.gdh-buy-person img').evaluate(e => e.hidden), true);
  pass('头像在人数左侧并按买家去重，缺图回退首字，点击头像可展开');
  // Populate the same IndexedDB schema as GMGN, only in this isolated browser fixture.
  const writeMarks = async (evm, sol = {}) => page.evaluate(async ({ evm, sol }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('gmgn');
      r.onupgradeneeded = () => r.result.createObjectStore('app_state');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('app_state', 'readwrite');
        tx.objectStore('app_state').put(evm, 'mark_wallet_v1_evm');
        tx.objectStore('app_state').put(sol, 'mark_wallet_v1_sol');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
    await testAggregate.refreshMarks();
  }, { evm, sol });
  const wallet2 = '0x' + '2'.repeat(40), wallet3 = '0x' + '3'.repeat(40);
  await writeMarks({ [wallet2]: { mark: 'ed', image: '/remark-avatar.png' }, [wallet3]: { mark: 'ed新' } });
  assert.deepEqual(await page.locator('.gdh-buy-people > div > span').allTextContents(), ['ed', 'ed新', '人物4']);
  assert.ok((await page.locator('.gdh-buy-person').first().getAttribute('title')).startsWith('ed ·'));
  assert.equal(await page.locator('.gdh-buy-person img').first().getAttribute('src'), 'https://gmgn.ai/remark-avatar.png');
  assert.equal(await page.locator('.gdh-buy-count').first().innerText(), '♙ 3');
  pass('读取 GMGN 本地 IndexedDB 备注，备注优先于昵称；头像提示同步，买家数不变');
  await writeMarks({ [wallet2]: { mark: '更新后的备注' }, [wallet3]: { mark: '<img src=x onerror="window.xss=true">' } });
  assert.equal(await page.locator('.gdh-buy-people > div > span').first().innerText(), '更新后的备注');
  assert.equal(await page.locator('.gdh-buy-people > div > span').nth(1).innerText(), '<img src=x onerror="window.xss=true">');
  assert.equal(await page.locator('.gdh-buy-people img').count(), 0);
  assert.equal(await page.evaluate(() => window.xss), undefined);
  await page.evaluate(async () => {
    const open = indexedDB.open;
    try { indexedDB.open = () => { throw new Error('fixture unavailable'); }; await testAggregate.refreshMarks(); }
    finally { indexedDB.open = open; }
  });
  assert.equal(await page.locator('.gdh-buy-people > div > span').first().innerText(), '更新后的备注');
  await writeMarks({});
  assert.deepEqual(await page.locator('.gdh-buy-people > div > span').allTextContents(), ['人物2', '人物3', '人物4']);
  pass('备注修改和删除即时反映；读取失败保留缓存，备注作为纯文本而非 HTML');
  await page.locator('[data-filter=sort]').selectOption('buyUsd');
  assert.ok((await page.locator('.gdh-buy-row a strong').first().innerText()).includes('<img'));
  const amount = page.locator('[data-filter=minUsd]'); await amount.fill('2500'); await amount.dispatchEvent('change');
  assert.equal(await page.locator('.gdh-buy-list article').count(), 0);
  await amount.fill('500'); await amount.dispatchEvent('change');
  assert.equal(await page.locator('.gdh-buy-list article').count(), 1);
  pass('金额排序和金额门槛生效，空列表提供明确说明');
  await page.evaluate(() => { window.inputBefore = document.querySelector('[data-filter=minUsd]'); testAggregate.paint(); });
  assert.equal(await page.evaluate(() => window.inputBefore === document.querySelector('[data-filter=minUsd]')), true);
  pass('数据重绘不重建筛选输入框，编辑状态保留');
  await page.evaluate(() => document.addEventListener('gdh-navigate', () => {
    window.nav = { url: document.documentElement.getAttribute('data-gdh-nav'), spa: document.documentElement.getAttribute('data-gdh-nav-spa-only') };
  }));
  const originalUrl = page.url();
  const link = page.locator('[data-aggregate-token]').first(), box = await link.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.evaluate(() => { window.pressedLink = document.querySelector('[data-aggregate-token]'); testAggregate.paint(); });
  assert.equal(await page.evaluate(() => pressedLink === document.querySelector('[data-aggregate-token]')), true);
  await page.mouse.up();
  const nav = await page.evaluate(() => window.nav);
  assert.equal(nav.url, '/bsc/token/0x' + '9'.repeat(40)); assert.equal(nav.spa, '1'); assert.equal(page.url(), originalUrl);
  pass('普通点击委托现有 SPA 路由，不触发整页刷新');
  await page.reload(); await setup();
  assert.equal(await page.locator('[data-filter=minUsd]').inputValue(), '500');
  assert.equal(await page.locator('[data-filter=sort]').inputValue(), 'buyUsd');
  assert.equal(await page.locator('.gdh-buy-list article').count(), 1);
  pass('窗口、人数、金额和排序配置本地持久化');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  const light = await page.locator('.gdh-buy-monitor').evaluate(e => ({ bg: getComputedStyle(e).backgroundColor, text: getComputedStyle(e).color, overflow: e.scrollWidth > e.clientWidth }));
  assert.equal(light.bg, 'rgb(255, 255, 255)'); assert.equal(light.text, 'rgb(27, 32, 40)'); assert.equal(light.overflow, false);
  assert.equal(await page.locator('.gdh-buy-positive').first().evaluate(e => getComputedStyle(e).color), 'rgb(8, 123, 86)');
  assert.equal(await page.locator('.gdh-buy-count').first().evaluate(e => getComputedStyle(e).color), 'rgb(8, 124, 145)');
  assert.equal((await stripe()).color, 'rgb(234, 178, 4)');
  pass('浅色主题文字有对比度，360px 原生面板内无横向溢出');
  await page.locator('[data-filter=minUsd]').fill('0'); await page.locator('[data-filter=minUsd]').dispatchEvent('change');
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-gdh-buy-aggregate-feeds', JSON.stringify({ reset: true, enabled: { fomo: false, pump: false } }));
    document.dispatchEvent(new Event('gdh-buy-aggregate-feeds')); testAggregate.paint();
  });
  assert.ok(!(await page.locator('.gdh-buy-list').innerText()).includes('FOMO'));
  assert.ok(!(await page.locator('.gdh-buy-list').innerText()).includes('PUMP'));
  assert.equal(await page.locator('#original').innerText(), '原生追踪保持不变');
  await page.evaluate(() => testAggregate.ingest(Array.from({ length: 8 }, (_, i) => ({
    source: 'gmgn', type: 'buy', chain: 'bsc', addr: '0x' + '8'.repeat(40),
    wallet: '0x' + (i + 10).toString(16).padStart(40, '0'), tx: `test-many-${i}`, ts: Date.now(),
    usd: 9999, name: `头像${i}`, symbol: '很多人买入',
  }))));
  assert.equal(await page.locator('.gdh-buy-count').first().innerText(), '♙ 8');
  assert.equal(await page.locator('.gdh-buy-avatars').first().locator('.gdh-buy-person').count(), 5);
  pass('多人买入最多显示五个头像，右侧仍显示完整人数');
  await page.evaluate(() => testAggregate.ingest(['sol', 'robinhood', 'unknown'].flatMap(chain => [10, 11].map(i => ({
    source: 'gmgn', type: 'buy', chain, addr: '0x' + '7'.repeat(40),
    wallet: '0x' + i.toString(16).padStart(40, '0'), tx: `${chain}-${i}`, ts: Date.now(), usd: 200, symbol: chain,
  })))));
  const colors = await page.locator('.gdh-buy-list article').evaluateAll(rows => Object.fromEntries(rows.map(el => [
    el.querySelector('.gdh-buy-row a small').textContent, getComputedStyle(el, '::before').backgroundColor,
  ])));
  assert.equal(colors.SOL, 'rgb(123, 68, 242)');
  assert.equal(colors.ROBINHOOD, 'rgb(159, 199, 0)');
  assert.equal(colors.UNKNOWN, 'rgb(138, 147, 166)');
  pass('不同链使用对应追踪链色，未知链保留中性细条');
  const solA = 'Ab' + '1'.repeat(30), solB = 'ab' + '1'.repeat(30), solToken = 'Cd' + '1'.repeat(30);
  await writeMarks({}, { [solA]: { mark: 'SOL 备注 A' }, [solB]: { mark: 'SOL 备注 B' } });
  await page.evaluate(({ solA, solB, solToken }) => testAggregate.ingest([solA, solB].map(wallet => ({
    source: 'gmgn', type: 'buy', chain: 'sol', addr: solToken, wallet, tx: `sol-${wallet}`, ts: Date.now(),
    usd: 200, name: '', symbol: 'SOL 备注隔离',
  }))), { solA, solB, solToken });
  const solRow = page.locator(`.gdh-buy-list article:has(a[href="/sol/token/${solToken}"])`);
  await solRow.locator('.gdh-buy-count').click();
  assert.deepEqual(await solRow.locator('.gdh-buy-people > div > span').allTextContents(), ['SOL 备注 A', 'SOL 备注 B']);
  assert.equal(await solRow.locator('.gdh-buy-count').innerText(), '♙ 2');
  pass('SOL 备注独立于 EVM，大小写不同的钱包不串备注或合并人数');
  assert.deepEqual(errors, []);
  pass('关闭来源后清理对应缓存，不改动原生面板，无浏览器脚本异常');
  await page.screenshot({ path: new URL('../dist/v84-aggregate-ui-light.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') });
  console.log(`aggregate monitor UI: ${n} checks passed`);
} finally { await browser.close(); }
