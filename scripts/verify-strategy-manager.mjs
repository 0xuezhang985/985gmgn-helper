// Offline fixtures execute the real GMGN / DeBot star-manager functions. No user profile or API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const take = (file, name) => {
  const source = read(file), start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
const browser = await chromium.launch({ headless: true });
let checks = 0;
const pass = name => console.log(`PASS ${++checks}: ${name}`);
try {
  for (const site of ['gmgn', 'debot']) {
    const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="root" data-sentry-component="WalletTrack" style="position:relative;width:430px;height:800px"><header data-sentry-component="TrackingHeader" style="height:40px"></header></div>');
    await page.addStyleTag({ content: read(site === 'gmgn' ? 'styles.css' : 'debot-styles.css') });
    await page.addScriptTag({ content: read('buy-strategies.js') });
    let worker;
    vm.runInNewContext(read('buy-strategies.js'), { URL, chrome: { runtime: { id: 'test', onMessage: { addListener: f => worker = f } }, storage: { local: {
      get: async () => page.evaluate(() => structuredClone(stored)),
      set: async next => page.evaluate(next => { if (failWrite) throw Error('quota'); Object.assign(stored, next); Object.assign(settings, next); writes++; scan(); }, next),
    } } } });
    await page.exposeFunction('strategyRequest', message => new Promise(resolve => worker(message, { id: 'test', url: `https://${site}.ai/` }, resolve)));
    await page.evaluate(({ A, B }) => {
      window.settings = { specialWallets: [{ address: A, label: '学长' }, { address: B, label: '测试人物' }], priorityBuyStrategies: {} };
      window.specialWalletMap = new Map(settings.specialWallets.map(p => [p.address, { ...p, color: '#aaa' }]));
      window.specialManageOpen = false; window.stored = {}; window.failWrite = false; window.writes = 0;
      window.chrome = { runtime: { sendMessage: window.strategyRequest }, storage: { local: {
        get: async () => structuredClone(stored),
        set: async next => { if (failWrite) throw Error('quota'); Object.assign(stored, next); Object.assign(settings, next); writes++; window.scan(); },
      } } };
      window.applySwatchColor = () => {}; window.openColorPalette = window.openSpecialPalette = () => {};
      window.blockedTokenSet = () => new Set(); window.renderBlockedTokenList = () => {};
      window.scheduleScan = window.scheduleFeedLayout = () => window.scan();
      window.normalizeWalletAddress = value => /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : '';
      window.toggleSpecialWallet = (address, label) => {
        if (specialWalletMap.has(address)) specialWalletMap.delete(address);
        else specialWalletMap.set(address, { address, label, color: '#aaa' });
        settings.specialWallets = [...specialWalletMap.values()]; window.scan();
      };
      window.addSpecialWallet = (address, label) => {
        if (!normalizeWalletAddress(address) || specialWalletMap.has(address)) return false;
        toggleSpecialWallet(address, label); return true;
      };
    }, { A, B });
    const code = site === 'gmgn'
      ? ['specialEntries', 'ensureSpecialManageUI', 'ensureSpecialManageModal', 'renderSpecialManageList'].map(n => take('content.js', n)).join('\n') + '\nwindow.scan=()=>ensureSpecialManageUI();'
      : take('debot-content.js', 'ensureSpecialManageUI') + '\nwindow.scan=()=>ensureSpecialManageUI(document.querySelector("#root"));';
    await page.addScriptTag({ content: code }); await page.evaluate(() => scan());
    const button = site === 'gmgn' ? '.gdh-sp-manage-button' : '.gdh-debot-special-manage-button';
    await page.locator(button).click();
    assert.equal(await page.getByRole('tab').count(), 2);
    await page.getByRole('tab', { name: /策略追踪/ }).click();
    const field = key => page.locator(`[data-buy="${key}"]`);
    assert.equal(await field('group-enabled').isChecked(), false);
    assert.equal(await field('amount-enabled').isChecked(), false);
    assert.equal(await page.evaluate(() => writes), 0);
    pass(`${site}: 原星条打开双分栏，默认关闭且打开不写设置`);
    await field('group-picker').selectOption(`${A} 学长`); await field('group-picker').selectOption(`${B} 测试人物`);
    await field('group-enabled').check(); await field('group-window').fill('120');
    await page.evaluate(C => {
      window.editorBefore = document.querySelector('.gdh-strategy-editor');
      for (let i = 0; i < 500; i++) scan();
      toggleSpecialWallet(C, '新增人物');
    }, C);
    await page.getByRole('tab', { name: '特别关注', exact: true }).click();
    await page.getByRole('tab', { name: /策略追踪/ }).click();
    assert.equal(await field('group-window').inputValue(), '120');
    assert.equal(await field('group-wallets').inputValue(), `${A} 学长\n${B} 测试人物`);
    assert.equal(await page.evaluate(() => editorBefore === document.querySelector('.gdh-strategy-editor')), true);
    assert.equal(await field('group-picker').locator('option').count(), 4);
    await page.getByRole('button', { name: '保存本组', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('已保存'));
    assert.equal(await page.evaluate(() => stored.priorityBuyStrategies.groups[0].conditions.group.windowSeconds), 120);
    assert.equal(await page.evaluate(() => stored.priorityBuyStrategies.groups[0].conditions.group.enabled), true);
    pass(`${site}: 500 次扫描、人物名单变化及切换分栏不丢草稿，保存原配置成功`);
    await field('group-wallets').fill(A); await page.getByRole('button', { name: '保存本组', exact: true }).click();
    assert.match(await page.locator('.gdh-strategy-status').innerText(), /至少需要 2/);
    assert.equal(await page.evaluate(() => writes), 1);
    await page.getByRole('button', { name: '重新读取' }).click();
    await field('amount-picker').selectOption(`${A} 学长`); await field('amount-enabled').check();
    await field('amount-usd').fill('2300.5'); await page.evaluate(() => { failWrite = true; });
    await page.getByRole('button', { name: '保存本组', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('保存失败'));
    assert.equal(await field('amount-usd').inputValue(), '2300.5');
    await page.evaluate(() => { failWrite = false; }); await page.getByRole('button', { name: '保存本组', exact: true }).click();
    await page.waitForFunction(() => stored.priorityBuyStrategies.groups[0].conditions.amount.minUsd === 2300.5);
    pass(`${site}: 无效配置不保存，存储失败保留草稿并可重试`);
    await page.evaluate(() => { stored.priorityBuyStrategies.groups[0].conditions.group.windowSeconds = 333; settings.priorityBuyStrategies = structuredClone(stored.priorityBuyStrategies); scan(); });
    assert.equal(await field('group-window').inputValue(), '333');
    await field('group-window').fill('444');
    await page.evaluate(() => { stored.priorityBuyStrategies.groups[0].conditions.group.windowSeconds = 555; settings.priorityBuyStrategies = structuredClone(stored.priorityBuyStrategies); scan(); });
    assert.equal(await field('group-window').inputValue(), '444');
    assert.equal(await page.getByRole('button', { name: '保存本组', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '重新读取' }).click();
    assert.equal(await field('group-window').inputValue(), '555');
    // External write arriving before the normal scanner runs must not be overwritten either.
    await field('group-window').fill('666');
    await page.evaluate(() => { stored.priorityBuyStrategies = structuredClone(stored.priorityBuyStrategies); stored.priorityBuyStrategies.groups[0].conditions.group.windowSeconds = 777; });
    await page.getByRole('button', { name: '保存本组', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gdh-strategy-status').textContent.includes('其他页面修改'));
    assert.equal(await page.evaluate(() => stored.priorityBuyStrategies.groups[0].conditions.group.windowSeconds), 777);
    pass(`${site}: 外部设置同步、未保存草稿冲突保护及延迟扫描防覆盖`);
    await page.evaluate(() => { settings.priorityBuyStrategies = structuredClone(stored.priorityBuyStrategies); scan(); });
    await page.getByRole('button', { name: '重新读取' }).click();
    const size = await page.locator('.gdh-strategy-editor').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, height: el.clientHeight }));
    assert.ok(size.height > 100); assert.ok(size.scroll <= size.width + 1, JSON.stringify(size));
    const tabs = await page.locator('.gdh-manager-tabs').boundingBox();
    const modalBox = await page.locator(site === 'gmgn' ? '.gdh-sp-manage-modal' : '.gdh-debot-special-manage').boundingBox();
    assert.ok(tabs.y >= modalBox.y && tabs.y + tabs.height < modalBox.y + modalBox.height, 'tabs must stay visible while editing');
    await page.screenshot({ path: new URL(`../dist/strategy-manager-${site}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
    await page.getByRole('tab', { name: '特别关注', exact: true }).click();
    await page.getByRole('button', { name: '移除', exact: true }).last().click();
    assert.equal(await page.evaluate(() => specialWalletMap.size), 2);
    const close = site === 'gmgn' ? '.gdh-sp-manage__close' : '.gdh-debot-special-manage__head button';
    await page.locator(close).click(); await page.locator(button).click();
    await page.getByRole('tab', { name: /策略追踪/ }).click();
    assert.equal(await field('group-window').inputValue(), '777');
    assert.deepEqual(errors, []);
    pass(`${site}: 布局不横向溢出、原人物移除仍可用、关闭重开读取最新设置，无 JS 异常`);
    await page.close();
  }
  console.log(`1..${checks}`);
} finally { await browser.close(); }
