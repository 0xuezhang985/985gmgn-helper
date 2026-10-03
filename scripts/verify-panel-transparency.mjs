// Production controls/renderers in isolated Chromium; synthetic storage, no live APIs/profile changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.BGM_TEST_SOURCE || fileURLToPath(new URL('../', import.meta.url));
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const take = (s, name) => { const start = s.indexOf(`  function ${name}(`); assert.ok(start >= 0, name); return s.slice(start, s.indexOf('\n  }', start) + 4); };
const shared = read('priority-push.js').split('/* Persistent, local-only priority alerts.')[0];
assert.match(shared, /GDHPanelTransparency/);
const store = { specialWallets: [{ address: 'preserved-fixture' }] }, writes = [], pages = new Set(), errors = [];
let checks = 0, failSave = false;
const check = (value, label) => { assert.ok(value, label); console.log(`PASS ${++checks}: ${label}`); };
async function write(values) {
  if (failSave) return 'fixture write failed';
  writes.push(values); Object.assign(store, values);
  const changes = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }]));
  await Promise.all([...pages].map(p => p.evaluate(c => window.listeners.forEach(f => f(c, 'local')), changes).catch(() => {})));
  return null;
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const site of ['gmgn', 'debot']) {
    const source = read(site === 'gmgn' ? 'content.js' : 'debot-content.js');
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    pages.add(page); page.on('pageerror', e => errors.push(`${site}: ${e.message}`));
    await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101418;color:#cbd2dd;font:18px/2 system-ui}.native{padding:30px;background:repeating-linear-gradient(0deg,#20262c 0 2px,transparent 2px 42px)}</style><div class="native">NATIVE PAGE / 原生内容<br>Wallet holders / 持有人<br>Current holdings / 当前持仓<br>Buy amount / 买入金额<br>Trade history / 交易历史<br>Native chart / 原生图表</div><div id="track"></div>' }));
    await page.exposeFunction('fixtureGet', async defaults => ({ ...defaults, ...store }));
    await page.exposeFunction('fixtureSet', write);
    await page.goto(`https://${site}.ai/bsc/token/0x${'1'.repeat(40)}`);
    await page.addStyleTag({ content: read(site === 'gmgn' ? 'styles.css' : 'debot-styles.css') });
    await page.evaluate(() => {
      window.listeners = []; window.fetchCount = 0;
      window.fetch = () => { fetchCount++; throw new Error('Unexpected API call'); };
      window.chrome = { runtime: {}, storage: { local: {
        get: (defaults, cb) => fixtureGet(defaults).then(cb),
        set: (data, cb) => fixtureSet(data).then(error => { chrome.runtime.lastError = error ? { message: error } : null; cb?.(); chrome.runtime.lastError = null; }),
      }, onChanged: { addListener: f => listeners.push(f) } } };
    });
    await page.addScriptTag({ content: shared });
    const pinNames = ['similarTokenPinnedPosition', 'saveSimilarTokenPin', 'syncSimilarTokenPinButton', 'bindSimilarTokenPanelControls'];
    const fomoNames = site === 'gmgn' ? ['buildFomoPanel', 'makeFomoDraggable', 'applyFomoFold', 'setFomoOpen'] : ['buildPanel', 'makePanelDraggable'];
    await page.addScriptTag({ content: `
      const settings={}; let similarTokenPanelEl=null,similarTokenPanelKey='',similarTokenDrag=null,similarTokenUserPosition=null,similarTokenDismissedRoute='';
      const currentTokenRoute=()=>({chain:'bsc',address:'0x'+'1'.repeat(40)}), debotTokenRoute=currentTokenRoute;
      const similarTokenMetaKey=(chain,address)=>chain+':'+address;
      const bindSimilarTokenRowActions=(row)=>row.addEventListener('click',()=>window.tokenClicks++);
      const similarTokenMoney=value=>'$'+Math.round(value).toLocaleString();
      const positionSimilarTokenPanel=()=>{Object.assign(similarTokenPanelEl.style,{left:(similarTokenUserPosition?.left||60)+'px',top:(similarTokenUserPosition?.top||60)+'px'});syncSimilarTokenPinButton()};
      const scheduleSimilarTokenPosition=positionSimilarTokenPanel;
      const clearSimilarTokenPanel=()=>{GDHPanelTransparency.detach(similarTokenPanelEl);similarTokenPanelEl?.remove();similarTokenPanelEl=null;similarTokenPanelKey=''};
      ${pinNames.map(n => take(source, n)).join('\n')}
      ${take(source, 'renderSimilarTokenPanel')}
      const safeText=x=>String(x||''), validImageUrl=()=>'';
      let fomoTab='holders',panelTab='holders',panel=null,fomoPanelEl=null;
      const syncTranslationButton=()=>{},loadFomoData=()=>{},loadPanel=()=>{};
      const syncPanel=()=>{GDHPanelTransparency.detach(panel);panel?.remove();panel=null};
      const scheduleScan=()=>{GDHPanelTransparency.detach(fomoPanelEl);fomoPanelEl?.remove();fomoPanelEl=null};
      ${fomoNames.map(n => take(source,n)).join('\n')}
      window.tokenClicks=0;
      window.fixtureBuild=()=>{
        const current=currentTokenRoute();
        renderSimilarTokenPanel(document.querySelector('#track'),current,[{...current,name:'UI TEST TOKEN',symbol:'TEST',marketCap:607600,poolSymbol:'QQQB'},{...current,address:'0x'+'2'.repeat(40),name:'UI TEST SIMILAR',symbol:'TEST',marketCap:4400}]);
        ${site === 'gmgn' ? 'fomoPanelEl=buildFomoPanel();panel=fomoPanelEl;' : 'panel=buildPanel();'}
        document.body.append(panel);Object.assign(panel.style,{left:'500px',top:'210px'});
        panel.querySelector('${site === 'gmgn' ? '.gdh-fomo__stats' : '.gdh-debot-fomo__stats'}').innerHTML='<div>FOMO holders<br><b>360</b></div><div>FOMO share<br><b>5.07%</b></div>';
      };fixtureBuild();
    ` });
    const similar = page.locator('[data-gdh-transparency-kind="similar"]'), fomo = page.locator('[data-gdh-transparency-kind="fomo"]');
    const menu = page.locator('.gdh-panel-transparency-menu');
    const opacity = loc => loc.evaluate(el => getComputedStyle(el).opacity);
    for (const loc of [similar, fomo]) {
      const overflow = await loc.evaluate(panel => { const r=panel.getBoundingClientRect(); return [...panel.firstElementChild.querySelectorAll('button,a')].filter(el=>{const b=el.getBoundingClientRect();return b.width>0&&(b.left<r.left||b.right>r.right)}).map(el=>el.className); });
      check(overflow.length === 0, `${site}: expanded header controls remain inside panel: ${overflow.join(',')}`);
    }
    check(await similar.locator('.gdh-panel-transparency-button').count() === 1 && await fomo.locator('.gdh-panel-transparency-button').count() === 1, `${site}: both production panels expose one control`);
    if (site === 'debot') {
      await page.waitForFunction(() => document.querySelector('[data-gdh-transparency-kind="similar"]').style.opacity === '0.4');
      check(await opacity(fomo) === '0.6', 'new document restores both preferences from saved storage');
    }
    await write({ similarTokenPanelTransparency: 0, fomoPanelTransparency: 0 });
    check(await opacity(similar) === '1' && await opacity(fomo) === '1', `${site}: default appearance unchanged`);
    const before = await similar.boundingBox();
    await similar.locator('.gdh-panel-transparency-button').click();
    check(JSON.stringify(before) === JSON.stringify(await similar.boundingBox()), `${site}: clicking opacity never drags the panel`);
    const writeCount = writes.length;
    await menu.locator('input').fill('60');
    check(await opacity(similar) === '0.4' && await opacity(fomo) === '1', `${site}: live fade includes background, rows and text; FOMO independent`);
    check(await similar.evaluate(el => getComputedStyle(el).backdropFilter) === 'none', `${site}: underlying page is not blurred`);
    check(await menu.evaluate(el => getComputedStyle(el).opacity) === '1' && await menu.locator('output').textContent() === '60%', `${site}: editor stays fully readable outside faded panel`);
    check(writes.length <= writeCount + 1, `${site}: input does not write storage for every preview frame`);
    await menu.locator('input').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.gdh-panel-transparency-menu [role=status]').textContent.includes('Saved'));
    check(store.similarTokenPanelTransparency === 60, `${site}: persisted transparency on commit`);
    await page.keyboard.press('Escape');
    check(await menu.count() === 0, `${site}: Escape closes only opacity editor`);
    check(await similar.locator('.gdh-panel-transparency-button').evaluate(el => el === document.activeElement), `${site}: keyboard focus restored to opener`);
    await fomo.locator('.gdh-panel-transparency-button').click();
    await menu.locator('input').fill('40'); await menu.locator('input').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.gdh-panel-transparency-menu [role=status]').textContent.includes('Saved'));
    check(await opacity(fomo) === '0.6' && await opacity(similar) === '0.4', `${site}: second type persists separately`);
    await page.keyboard.press('Escape');
    const fold = fomo.locator(site === 'gmgn' ? '.gdh-fomo__fold' : '.gdh-debot-fomo__fold');
    await fold.click();
    check(await fomo.evaluate(el => el.classList.contains('is-folded')) && await opacity(fomo) === '0.6', `${site}: folding preserves transparency`);
    await similar.locator(site === 'gmgn' ? '.gdh-similar-token__pin' : '.gdh-debot-similar-token__pin').click();
    check(await similar.evaluate(el => el.classList.contains('is-pinned')), `${site}: pin control still works`);
    const header = fomo.locator(site === 'gmgn' ? '.gdh-fomo__bar' : '.gdh-debot-fomo__bar');
    const box = await header.boundingBox();
    await page.mouse.move(box.x + 24, box.y + 16); await page.mouse.down(); await page.mouse.move(box.x + 64, box.y + 46); await page.mouse.up();
    check(await fomo.evaluate(el => el.style.left) === '540px', `${site}: dragging unchanged while faded`);
    await similar.locator('[aria-current="true"]').click();
    check(await page.evaluate(() => tokenClicks) === 1, `${site}: token click still works; no click-through enabled`);
    await similar.locator('.gdh-panel-transparency-button').click();
    await menu.locator('footer button').click();
    await page.waitForFunction(() => document.querySelector('[data-gdh-transparency-kind="similar"]').style.opacity === '1');
    check(await opacity(similar) === '1' && await opacity(fomo) === '0.6', `${site}: reset only changes current type`);
    await page.keyboard.press('Escape');
    await write({ similarTokenPanelTransparency: 999, fomoPanelTransparency: -20 });
    check(await opacity(similar) === '0.2' && await opacity(fomo) === '1', `${site}: invalid settings clamped, panel never fully disappears`);
    check(await page.evaluate(async () => {let n=0;const o=new MutationObserver(ms=>n+=ms.length);o.observe(document.body,{subtree:true,attributes:true,childList:true});listeners.forEach(f=>f({unrelatedCounter:{newValue:123}},'local'));await Promise.resolve();o.disconnect();return n===0}), `${site}: unrelated storage changes produce zero DOM writes`);
    await write({ similarTokenPanelTransparency: 60, fomoPanelTransparency: 40 });
    await similar.locator('.gdh-panel-transparency-button').click();
    await page.evaluate(() => clearSimilarTokenPanel());
    check(await menu.count() === 0, `${site}: removing panel cleans detached editor`);
    await fomo.locator(site === 'gmgn' ? '.gdh-fomo__close' : '.gdh-debot-fomo__close').click();
    check(await fomo.count() === 0, `${site}: existing close button still works`);
    await page.evaluate(() => fixtureBuild());
    check(await opacity(similar) === '0.4' && await opacity(fomo) === '0.6', `${site}: reopening restores saved appearance`);
    await similar.locator('.gdh-panel-transparency-button').click();
    failSave = true;
    await menu.locator('input').fill('55'); await menu.locator('input').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.gdh-panel-transparency-menu [role=status]').textContent.includes('failed'));
    check(await menu.locator('[role=status]').textContent() === 'Save failed / 保存失败', `${site}: failed persistence is not reported as success`);
    failSave = false; await page.keyboard.press('Escape');
    await write({ similarTokenPanelTransparency: 60, fomoPanelTransparency: 40 });
    if (site === 'gmgn') {
      await similar.locator('.gdh-panel-transparency-button').click();
      fs.mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL('../dist/v120-panel-transparency.png', import.meta.url)) });
      await page.keyboard.press('Escape');
    }
    check(await page.evaluate(() => fetchCount) === 0, `${site}: transparency makes no API calls`);
  }
  await write({ similarTokenPanelTransparency: 35 });
  check((await Promise.all([...pages].map(p => p.locator('[data-gdh-transparency-kind="similar"]').evaluate(el => el.style.opacity)))).every(x => x === '0.65'), 'cross-site settings propagate to every open panel');
  check(store.specialWallets[0].address === 'preserved-fixture', 'unrelated wallet configuration preserved');
  const popup = read('popup.js'), html = read('popup.html');
  const settingsPage = await browser.newPage({ viewport: { width: 440, height: 900 } });
  settingsPage.on('pageerror', e => errors.push(`popup: ${e.message}`));
  await settingsPage.route('**/*', r => r.abort());
  await settingsPage.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
  await settingsPage.addStyleTag({ content: read('popup.css') });
  const inputCode = popup.slice(popup.indexOf('const transparencyInputs ='), popup.indexOf('const gmgnHoldingSyncStatus ='));
  const listenerStart = popup.indexOf('chrome.storage.onChanged.addListener((changes, areaName) => {');
  const listener = popup.slice(listenerStart, popup.indexOf('\n});', listenerStart) + 4);
  await settingsPage.addScriptTag({ content: `const chrome={storage:{onChanged:{addListener:f=>window.onStorage=f}}};${inputCode};${listener};for(const key of Object.keys(transparencyInputs))setTransparencyInput(key,${JSON.stringify(store)}[key]);` });
  check(await settingsPage.locator('#similar-token-panel-transparency').inputValue() === '35' && await settingsPage.locator('#fomo-panel-transparency').inputValue() === '40', 'settings renders saved numeric values');
  await settingsPage.locator('#similar-token-panel-transparency').fill('55');
  check(await settingsPage.locator('#similar-token-panel-transparency + output').textContent() === '55%', 'settings range updates its visible percentage');
  await settingsPage.evaluate(() => onStorage({ fomoPanelTransparency: { newValue: 60 } }, 'local'));
  check(await settingsPage.locator('#fomo-panel-transparency').inputValue() === '60', 'already-open settings reflects changes from a floating panel');
  await settingsPage.locator('.sub-settings:has(#fomo-panel-transparency)').screenshot({ path: fileURLToPath(new URL('../dist/v120-popup-transparency.png', import.meta.url)) });
  check(html.includes('Window transparency / 浮窗透明度 <em class="new-badge">NEW</em>'), 'settings marks new feature NEW');
  check(popup.includes('similarTokenPanelTransparency: 0') && popup.includes('fomoPanelTransparency: 0') && popup.includes('Object.entries(transparencyInputs).map(([key, input]) => [key, Number(input.value)])'), 'settings defaults and save use numeric transparency, not checkbox booleans');
  check(errors.length === 0, 'no browser exceptions: ' + errors.join(';'));
  console.log(`Panel transparency: ${checks} checks passed`);
} finally { await browser.close(); }
