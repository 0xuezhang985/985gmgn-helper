// Real worker + isolated-world code, synthetic DOM and storage; no user profile or APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = read('priority-push.js');
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40);
const stored = {}, pages = new Set();
let listener, failWrite = false, checks = 0;
const pass = (text) => console.log(`PASS ${++checks}: ${text}`);
const local = {
  async get(keys) {
    if (keys === null) return structuredClone(stored);
    if (typeof keys === 'string') return { [keys]: structuredClone(stored[keys]) };
    return Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, structuredClone(stored[key] ?? value)]));
  },
  async set(values) {
    if (failWrite) throw new Error('quota');
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: stored[key], newValue: value }]));
    Object.assign(stored, structuredClone(values));
    await Promise.all([...pages].map((page) => page.evaluate((changes) => window.storageListeners?.forEach((fn) => fn(changes, 'local')), changes).catch(() => {})));
  },
};
vm.runInNewContext(code, { URL, chrome: { runtime: { id: 'fixture', onMessage: { addListener: (fn) => { listener = fn; } } }, storage: { local } } });
const send = (site, message, id = 'fixture') => new Promise((resolve) => listener(message, { id, url: `https://${site}/test` }, resolve));
const record = (site) => ({ wallet, name: '测试重点人物', href: site === 'gmgn.ai' ? `/bsc/token/${token}` : `/token/bsc/${token}`, detail: '买入 测试币 TEST $147 MC:$335.1K' });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function fixture(site) {
  const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="root" style="position:relative;width:330px;height:600px;background:#111"></div>' }));
  await page.goto(`https://${site}/test`);
  await page.exposeFunction('sendFixture', (message) => send(site, message));
  await page.exposeFunction('storageGet', (keys) => local.get(keys));
  await page.exposeFunction('storageSet', (values) => local.set(values));
  await page.evaluate(() => {
    window.storageListeners = [];
    window.chrome = { runtime: { sendMessage: window.sendFixture }, storage: { local: { get: window.storageGet, set: window.storageSet }, onChanged: { addListener: (fn) => storageListeners.push(fn) } } };
  });
  pages.add(page);
  await page.addScriptTag({ content: code });
  await page.evaluate(({ wallet }) => {
    window.navigations = [];
    window.priorityView = {};
    window.api = GdhPriorityPush.create((href) => navigations.push(href), { view: () => priorityView });
    window.wallets = new Map([[wallet, { persistentPin: true }]]);
    api.setContext(document.querySelector('#root'), 45, wallets);
  }, { wallet });
  return page;
}
const capture = (page, site, id) => page.evaluate(({ id, record }) => api.capture(id, record), { id, record: record(site) });
const take = (file, name) => { const s = read(file), i = s.indexOf(`  function ${name}(`); assert.ok(i >= 0); return s.slice(i, s.indexOf('\n  }', i) + 4); };
try {
  assert.equal((await send('evil.example', { type: 'priority-push-list' })).ok, false);
  assert.equal((await send('gmgn.ai', { type: 'priority-push-list' }, 'other-extension')).ok, false);
  assert.equal((await send('gmgn.ai', { type: 'priority-push-add', id: 'bad', record: { ...record('gmgn.ai'), href: 'https://evil.example/token/a' } })).ok, false);
  pass('后台拒绝异站、其他扩展和外部跳转地址');
  const gmgn = await fixture('gmgn.ai');
  await capture(gmgn, 'gmgn.ai', 'event-1');
  await gmgn.waitForSelector('.gdh-priority-push article');
  await gmgn.clock.install(); await gmgn.clock.fastForward(12 * 60 * 60 * 1000);
  assert.equal(await gmgn.locator('.gdh-priority-push article').count(), 1);
  await gmgn.locator('.gdh-priority-push a').click();
  assert.equal(await gmgn.locator('.gdh-priority-push article').count(), 1);
  assert.equal(await gmgn.evaluate(() => navigations.length), 1);
  pass('经过十二小时仍置顶，点击跳币不关闭');
  await Promise.all(Array.from({ length: 24 }, (_, i) => capture(gmgn, 'gmgn.ai', `event-${i + 2}`)));
  assert.match(await gmgn.locator('.gdh-priority-push header').innerText(), /25 条/);
  assert.equal(await gmgn.locator('.gdh-priority-push article').count(), 20);
  await gmgn.getByRole('button', { name: '下一页' }).click();
  assert.equal(await gmgn.locator('.gdh-priority-push article').count(), 5);
  pass('超过三条不会丢弃；25 条按页显示，最多绘制 20 条');
  const restored = await fixture('gmgn.ai');
  await restored.waitForFunction(() => document.querySelector('.gdh-priority-push header')?.textContent.includes('25 条'));
  await restored.evaluate(() => { const old = document.querySelector('#root'); const next = old.cloneNode(false); old.replaceWith(next); api.setContext(next, 45, wallets); });
  assert.match(await restored.locator('.gdh-priority-push header').innerText(), /25 条/);
  pass('新页面与追踪面板重建都恢复未关闭提醒');
  const beforeKeys = Object.keys(stored).length;
  await Promise.all([capture(gmgn, 'gmgn.ai', 'event-1'), capture(restored, 'gmgn.ai', 'event-1')]);
  assert.equal(Object.keys(stored).length, beforeKeys);
  await restored.locator('.gdh-priority-push article>button').first().click();
  await restored.waitForFunction(() => document.querySelector('.gdh-priority-push header')?.textContent.includes('24 条'));
  assert.match(await gmgn.locator('.gdh-priority-push header').innerText(), /24 条/);
  const dismissed = Object.values(stored).find((value) => value.dismissed).id;
  const reload = await fixture('gmgn.ai');
  await capture(reload, 'gmgn.ai', dismissed);
  assert.match(await reload.locator('.gdh-priority-push header').innerText(), /24 条/);
  pass('重复扫描不新增，手动关闭跨标签同步，重开后同笔不复活');
  failWrite = true;
  await restored.locator('.gdh-priority-push article>button').first().click();
  await restored.waitForFunction(() => document.querySelector('.gdh-priority-push header')?.textContent.includes('关闭未保存'));
  assert.equal(await restored.locator('.gdh-priority-push article').count(), 20);
  failWrite = false;
  pass('存储失败明确提示，不伪报关闭成功或静默丢失');
  await reload.evaluate(() => api.setContext(document.querySelector('#root'), 45, new Map()));
  assert.equal(await reload.locator('.gdh-priority-push').count(), 0);
  assert.equal(Object.values(stored).filter((r) => !r.dismissed).length, 24);
  pass('取消人物勾选后隐藏，不误删未关闭的本地记录');
  const debot = await fixture('debot.ai');
  assert.equal(await debot.locator('.gdh-priority-push').count(), 0);
  await capture(debot, 'debot.ai', 'debot-1');
  assert.equal(await debot.locator('.gdh-priority-push article').count(), 1);
  const mutationCount = await debot.evaluate(async () => {
    let count = 0; const ob = new MutationObserver((rs) => count += rs.length); ob.observe(document.querySelector('#root'), { subtree: true, childList: true, attributes: true });
    for (let i = 0; i < 10; i++) api.setContext(document.querySelector('#root'), 45, wallets);
    await Promise.resolve(); ob.disconnect(); return count;
  });
  assert.equal(mutationCount, 0);
  pass('DeBot 独立恢复，稳定扫描零 DOM 改写');

  stored.prioritySettingsFixture = { enabled: true, groups: ['keep'] };
  await send('gmgn.ai', { type: 'priority-push-add', id: 'hidden-wallet', record: { ...record('gmgn.ai'), wallet: '0x' + '3'.repeat(40) } });
  failWrite = true;
  await restored.getByRole('button', { name: '全部清除', exact: true }).click();
  await restored.waitForFunction(() => document.querySelector('.gdh-priority-push header')?.textContent.includes('全部清除未保存'));
  assert.equal(await restored.locator('.gdh-priority-push article').count(), 20);
  failWrite = false;
  await restored.getByRole('button', { name: '全部清除', exact: true }).click();
  await restored.waitForFunction(() => !document.querySelector('.gdh-priority-push'));
  assert.equal(await gmgn.locator('.gdh-priority-push').count(), 0);
  assert.equal((await send('gmgn.ai', { type: 'priority-push-list' })).records.length, 0);
  assert.equal(await debot.locator('.gdh-priority-push article').count(), 1);
  assert.deepEqual(stored.prioritySettingsFixture, { enabled: true, groups: ['keep'] });
  await capture(restored, 'gmgn.ai', 'event-2');
  assert.equal(await restored.locator('.gdh-priority-push').count(), 0);
  const afterClear = await fixture('gmgn.ai');
  assert.equal(await afterClear.locator('.gdh-priority-push').count(), 0);
  pass('全清失败保留卡片；成功清除所有页及隐藏提醒，跨标签同步、重开不复活，不改策略或另一站提醒');
  const concurrent = await Promise.all([
    send('gmgn.ai', { type: 'priority-push-add', id: 'before-clear', record: record('gmgn.ai') }),
    send('gmgn.ai', { type: 'priority-push-clear' }),
    send('gmgn.ai', { type: 'priority-push-add', id: 'after-clear', record: record('gmgn.ai') }),
  ]);
  assert.ok(concurrent.every(r => r.ok));
  assert.ok(stored['gdhPriorityPushV1:gmgn.ai:before-clear'].dismissed);
  assert.ok(!stored['gdhPriorityPushV1:gmgn.ai:after-clear'].dismissed);
  assert.equal((await send('evil.example', { type: 'priority-push-clear' })).ok, false);
  pass('新增与全清串行处理，清除后到达的新提醒正常保留，外站不能执行全清');

  const rich = await fixture('gmgn.ai');
  await rich.route('https://gmgn.ai/static/*.png', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#5c8de5"/></svg>' }));
  const visual = await rich.evaluate(({ wallet, token }) => {
    const native = document.createElement('a');
    Object.assign(native.dataset, { gdhTrackMaker: wallet, gdhTrackAddr: token, gdhTrackChain: 'arc', gdhTrackSide: 'buy', gdhTrackUsd: '2000', gdhTrackMc: '6400000', gdhTrackSymbol: 'COOL', gdhTrackTs: String(Date.now() - 60000) });
    native.innerHTML = '<span style="background-color:#5c8de5"></span><div data-testid="follow-tracking-row-maker"><img src="/static/avatar.png"><a href="/arc/address/' + wallet + '">原生备注</a></div><span data-testid="follow-tracking-row-side">加仓</span><div data-testid="follow-tracking-row-amount"><img src="/static/usdc.png">2K</div><div data-testid="follow-tracking-row-symbol"><img src="/static/token.png"><span>COOL</span></div>';
    return GdhPriorityPush.describe(native);
  }, { wallet, token });
  assert.equal(visual.symbol, 'COOL'); assert.equal(visual.amount, '2K'); assert.equal(visual.mc, '$6.4M');
  assert.equal(visual.avatar, 'https://gmgn.ai/static/avatar.png');
  await rich.evaluate(({ data, wallet, token }) => api.capture('rich', { wallet, name: '设置备注', href: `/arc/token/${token}`, detail: '原生记录', visual: data }), { data: visual, wallet, token });
  const card = rich.locator('[data-priority-id="rich"]');
  assert.equal(await card.locator('.gdh-priority-name').innerText(), '设置备注');
  assert.equal(await card.locator('.gdh-priority-action').innerText(), '加仓');
  assert.equal(await card.locator('.gdh-priority-amount').innerText(), '2K');
  assert.equal(await card.locator('.gdh-priority-avatar img').count(), 2);
  const cardSize = await card.locator('a').boundingBox(); assert.equal(cardSize.height, 64.5);
  const urlBefore = await rich.evaluate(() => navigations.length);
  await card.locator('.gdh-priority-symbol').click();
  assert.equal(await rich.evaluate(() => navigations.length), urlBefore + 1);
  assert.equal(await card.count(), 1);
  await rich.screenshot({ path: new URL('../dist/priority-native-card-v90.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1') });
  await rich.evaluate(() => { priorityView = { table: true }; api.setContext(document.querySelector('#root'), 45, wallets); });
  assert.equal(await rich.locator('.gdh-priority-push.is-table').count(), 1);
  const cells = await card.locator('.gdh-priority-time,.gdh-priority-who,.gdh-priority-token,.gdh-priority-amount,.gdh-priority-mc').evaluateAll(nodes => nodes.map(e => ({ c: e.className, x: e.getBoundingClientRect().x, y: e.getBoundingClientRect().y, right: e.getBoundingClientRect().right })));
  const ordered = ['time','who','token','amount','mc'].map(k => cells.find(c => c.c === 'gdh-priority-' + k));
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i].x >= ordered[i - 1].right - 0.5);
  assert.ok(Math.max(...ordered.map(c=>c.y))-Math.min(...ordered.map(c=>c.y))<3);
  await rich.evaluate(() => { const s=document.documentElement.style; s.setProperty('--color-bg','255 255 255');s.setProperty('--color-text-100','26 26 26'); });
  assert.equal(await rich.locator('.gdh-priority-push').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
  assert.equal(await card.locator('.gdh-priority-name').evaluate(e=>getComputedStyle(e).color),'rgb(26, 26, 26)');
  await rich.screenshot({ path: new URL('../dist/priority-native-table-v90.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1') });
  pass('原生头像 / 报价图标 / 加仓 / 金额 / 市值持久保存，两行卡片切五列表格不重叠，浅色主题和站内点击保留');
  const unsafe = await send('gmgn.ai', { type: 'priority-push-add', id: 'unsafe-visual', record: { ...record('gmgn.ai'), visual: { avatar: 'javascript:alert(1)', tokenImage:'http://unsafe.example/a.png', color:'red;position:fixed', symbol:'<img onerror=alert(1)>', ts:1e100 } } });
  assert.equal(unsafe.record.visual.avatar,'');assert.equal(unsafe.record.visual.tokenImage,'');assert.equal(unsafe.record.visual.color,'');
  assert.equal(unsafe.record.visual.ts,0);
  assert.equal(await rich.locator('[data-priority-id="unsafe-visual"] .gdh-priority-symbol img').count(),0);
  pass('展示字段限长校验，禁止非 HTTPS 图片及任意 CSS，文本不作为 HTML 执行');

  for (const site of ['gmgn.ai', 'debot.ai']) for (const mode of ['card', 'list']) {
    const page = await fixture(site);
    await page.evaluate(({ site, mode, wallet, token }) => {
      const root = document.querySelector('#root'); root.innerHTML = '';
      root.setAttribute(site === 'gmgn.ai' ? 'data-sentry-component' : 'data-edge-dock-panel', site === 'gmgn.ai' ? 'WalletTrack' : 'track');
      const body = document.createElement('div'); body.id = 'rows'; body.setAttribute('data-sentry-component', 'TrackingBody'); root.appendChild(body);
      window.addNative = (tx) => {
        const row = document.createElement('a'); row.href = site === 'gmgn.ai' ? `/bsc/token/${token}` : `/token/bsc/${token}`;
        row.setAttribute('data-sentry-component', mode === 'card' ? 'TrackerListItem' : 'TableItem');
        Object.assign(row.dataset, { fixtureRow: '1', gdhTrackMaker: wallet, gdhTrackAddr: token, gdhTrackChain: 'bsc', gdhTrackSide: 'buy', gdhTrackTx: tx, gdhTrackTs: '1800000000', gdhDebotTrackTx: tx, gdhDebotTrackTs: '1800000000000' });
        row.innerHTML = '<span>测试人物</span><span>买入</span><span>TEST</span><span>$147</span><span>MC:$335K</span>';
        body.appendChild(row); return row;
      };
      addNative('baseline');
    }, { site, mode, wallet, token });
    if (site === 'gmgn.ai') {
      await page.addScriptTag({ content: `
        const specialWalletMap = new Map([['${wallet}',{label:'测试人物',persistentPin:true,pin:true}]]);
        const settings={enableSpecialWallet:true};
        const specialPinSeen=new Set(); const SPECIAL_PIN_SEEN_MAX=400; let specialPinBaselineDone=false;
        const priorityPush={capture:(id,record)=>{window.captured=[id,record]},setContext:()=>{}};
        const trackerCards=()=>[...document.querySelectorAll('[data-fixture-row]')];
        const extractRowWalletAddress=card=>card.dataset.gdhTrackMaker;
        const extractRowWalletLabel=()=>'测试人物';const pinTrackerCard=()=>{throw Error('must not double pin')};
        ${['hasPinnedWallets','trackerCardSignature','rememberPinSeen','scanPinnedPush'].map((n)=>take('content.js',n)).join('\n')}
        scanPinnedPush();addNative('${site}-${mode}-tx');scanPinnedPush();` });
    } else {
      await page.addScriptTag({ content: `
        const specialWalletMap = new Map([['${wallet}',{label:'测试人物',persistentPin:true,pin:true}]]);
        const specialPinSeen=new Set();const SPECIAL_PIN_SEEN_MAX=400;let specialPinBaselineDone=false;
        const settings={enableSpecialWallet:true};const isTrackShellPage=()=>true;
        const sidebarTrackLayout=()=>({list:document.querySelector('#rows')});
        const sidebarTrackRows=()=>[...document.querySelectorAll('[data-fixture-row]')];
        const applySpecialRow=()=>({address:'${wallet}',label:'测试人物',meta:specialWalletMap.get('${wallet}')});
        const ensureSpecialManageUI=()=>{};const safeText=(s,n)=>String(s||'').slice(0,n);const sidebarRowTime=()=>0;
        const priorityPush={capture:(id,record)=>{window.captured=[id,record]},setContext:()=>{}};
        const pinSidebarRow=()=>{throw Error('must not double pin')};
        ${['rememberSpecialPin','sidebarRowSignature','scanSidebarFeatures'].map((n)=>take('debot-content.js',n)).join('\n')}
        scanSidebarFeatures();addNative('${site}-${mode}-tx');scanSidebarFeatures();` });
    }
    const captured = await page.evaluate(() => captured);
    assert.ok(captured[0].includes(`${site}-${mode}-tx`));
    assert.equal(captured[1].wallet, wallet); assert.match(captured[1].detail, /测试人物 买入 TEST/);
    assert.match(captured[1].href, /\/token\//);
    pass(`${site} ${mode} 实际扫描函数识别新增事件，不同时创建短时置顶`);
  }
  const ui = await browser.newPage();
  await ui.setContent('<meta charset=utf-8><div id="priority-wallet-list"></div>');
  await ui.exposeFunction('getWallets', () => ({ specialWallets: [{ address: wallet, label: '测试人物', pin: true, color: '#123456' }] }));
  let saved;
  await ui.exposeFunction('saveWallets', (value) => { saved = value; });
  const popupSource=read('popup.js'), start=popupSource.indexOf('function renderPriorityWallets('), end=popupSource.indexOf('\n}',start)+2;
  await ui.addScriptTag({content:`window.chrome={storage:{local:{get:getWallets,set:saveWallets}}};${popupSource.slice(start,end)}`});
  await ui.evaluate(({wallet})=>renderPriorityWallets([{address:wallet,label:'测试人物'}]),{wallet});
  assert.equal(await ui.locator('input').isChecked(),false);
  await ui.locator('input').check();
  await ui.waitForFunction(()=>!document.querySelector('input').disabled);
  assert.equal(saved.specialWallets[0].persistentPin,true); assert.equal(saved.specialWallets[0].pin,true);assert.equal(saved.specialWallets[0].color,'#123456');
  pass('设置默认不勾选，逐人启用时保留原有颜色和十秒置顶偏好');
  await debot.screenshot({ path: new URL('../dist/priority-push-preview.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1') });
  console.log(`1..${checks}`);
} finally { await browser.close(); }
