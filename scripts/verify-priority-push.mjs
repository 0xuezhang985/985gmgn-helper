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
    window.api = GdhPriorityPush.create((href) => navigations.push(href));
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
