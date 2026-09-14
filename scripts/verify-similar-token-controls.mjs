// Isolated browser fixtures: no user profile, real API calls or settings writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const read = name => (process.argv.includes('--baseline')
  ? execFileSync('git', ['show', `v0.46.74:${name}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(new URL(name, root), 'utf8')).replace(/\r\n/g, '\n');
const take = (source, name) => { const start = source.indexOf(`  function ${name}(`); assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4); };
const addresses = Array.from({ length: 9 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
const pass = label => console.log(`PASS ${++checks}: ${label}`);
try {
  for (const site of ['gmgn', 'debot']) {
    const source = read(site === 'gmgn' ? 'content.js' : 'debot-content.js');
    const prefix = site === 'gmgn' ? '.gdh-similar-token' : '.gdh-debot-similar-token';
    const panel = prefix + '-panel', header = prefix + '__header', close = prefix + '__close';
    const href = (address, chain = 'bsc') => site === 'gmgn' ? `/${chain}/token/${address}` : `/token/${chain}/invite_${address}`;
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <style>body{background:#101114;color:#eee}#track{position:fixed;left:600px;top:60px;width:320px;height:700px}.native{height:40px}</style>
      <section id="track" data-edge-dock-panel="track" data-sentry-component="WalletTrack"><button data-testid="follow-tracking-tab">追踪</button>
      <div data-testid="virtuoso-scroller" data-sentry-component="TrackingBody" style="margin-top:40px">${addresses.slice(1).map((address, i) => `<div class="native" data-index="${i}" data-known-size="40"><a href="${href(address)}">BNC</a></div>`).join('')}</div></section>` }));
    await page.goto(`https://${site}.ai${href(addresses[0])}`);
    await page.addStyleTag({ content: read(site === 'gmgn' ? 'styles.css' : 'debot-styles.css') });
    await page.addScriptTag({ content: `
      const settings={enabled:true,enableSimilarTokenPanel:true,similarTokenCacheMinutes:5,blockedTokens:[]};
      const FOMO_NETWORK_ID={bsc:56,base:8453};
      const TRACK_TAB_CELL='[data-testid="follow-tracking-tab"]';
      const trackerCards=()=>[...document.querySelectorAll('.native')];
      const currentTokenRoute=()=>{const m=location.pathname.match(/^\\/(\\w+)\\/token\\/(\\w+)/);return m?{chain:m[1],address:m[2]}:null;};
      const gmgnApiQuery=()=>'';const scheduleScan=()=>{};const scheduleFeedLayout=()=>{};
      window.navigation=[];const gdhSpaNavigate=href=>navigation.push(href);
      window.fetchCount=0;window.fetch=()=>{fetchCount++;throw new Error('unexpected request');};
      window.chrome={storage:{local:{set:()=>{throw new Error('unexpected settings write');}}}};
      ${site === 'gmgn' ? 'const isTokenBlocked=()=>false;' : ''}
      ${(site === 'gmgn' ? ['trackingFeedNormalizedAddress','setBoundedMap'] : ['safeText','validImageUrl','normalizeAddress','debotTokenRoute','debotTokenHref','debotInvitePrefix']).map(name => take(source, name)).join('\n')}
      ${site === 'gmgn' ? source.slice(source.indexOf('  const SIMILAR_TOKEN_META_TTL'), source.indexOf('  function requestStonkfunRwaCatalog'))
        : source.slice(source.indexOf('  // ---- DeBot 同名 / 相似币'), source.indexOf('  function syncRoute()'))}
      const addresses=${JSON.stringify(addresses)};
      for(const chain of ['bsc','base']) addresses.forEach((address,i)=>similarTokenMetaCache.set(similarTokenMetaKey(chain,address),{at:Date.now(),data:{chain,address,name:i?'BNB STRATEGIES':'Built and Code',symbol:'BNC',marketCap:1390000/(i+1),poolSymbol:'B13B'}}));
      document.addEventListener('gdh-debot-navigate',e=>navigation.push(e.detail.href));
      window.addEventListener('resize',()=>scanSimilarTokenPanel());
      scanSimilarTokenPanel();
    ` });
    const rect = () => page.locator(panel).evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top }; });
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(close).count(), 1);
    assert.equal(await page.locator(prefix + '__row').count(), 9);
    assert.equal(await page.locator(close).getAttribute('aria-label'), '关闭同名币浮窗');
    pass(`${site}: 显示可聚焦的关闭按钮，不影响九行币种和当前币`);
    const initial = await rect();
    const start = await page.locator(header).boundingBox();
    await page.mouse.move(start.x + 40, start.y + 16); await page.mouse.down();
    await page.mouse.move(start.x + 160, start.y + 106, { steps: 5 }); await frame();
    assert.deepEqual(await rect(), { left: initial.left + 120, top: initial.top + 90 });
    await page.evaluate(() => {
      window.savedHeader = document.querySelector('aside > div');
      similarTokenMetaCache.get(similarTokenMetaKey('bsc',addresses[1])).data.marketCap = 9000000;
      scanSimilarTokenPanel();
    });
    assert.equal(await page.evaluate(() => savedHeader === document.querySelector('aside > div') && savedHeader.hasPointerCapture(1)), true);
    await page.mouse.move(start.x + 200, start.y + 136, { steps: 3 }); await page.mouse.up(); await frame();
    const moved = { left: initial.left + 160, top: initial.top + 120 };
    assert.deepEqual(await rect(), moved);
    assert.match(await page.locator(prefix + '__row').first().innerText(), /\$9M/);
    pass(`${site}: 行情更新中标题栏不重建，拖动连续且市值正常重排`);
    const writes = await page.evaluate(async () => {
      let n = 0; const o = new MutationObserver(records => n += records.length);
      o.observe(similarTokenPanelEl, { attributes: true, childList: true, subtree: true });
      for (let i = 0; i < 10; i++) scanSimilarTokenPanel();
      await Promise.resolve(); o.disconnect(); return n;
    });
    assert.equal(writes, 0); assert.deepEqual(await rect(), moved);
    pass(`${site}: 松手后后台扫描不复位，稳定扫描零 DOM 改写`);
    await page.setViewportSize({ width: 500, height: 360 }); await frame();
    const buttonRect = await page.locator(close).boundingBox();
    assert.ok(buttonRect.x >= 0 && buttonRect.x + buttonRect.width <= 500 && buttonRect.y >= 0 && buttonRect.y + buttonRect.height <= 360);
    assert.equal(await page.locator(prefix + '__list').evaluate(el => el.scrollHeight > el.clientHeight), true);
    await page.setViewportSize({ width: 1200, height: 900 }); await frame();
    assert.deepEqual(await rect(), moved);
    pass(`${site}: 桌面窗口缩小时自动收回边界，列表滚动、关闭按钮可见`);
    await page.evaluate(site => {
      const x = document.createElement('div'); x.id = 'native-preview'; x.setAttribute('role','tooltip');
      x.className = site === 'gmgn' ? 'pi-tooltip-container' : 'MuiTooltip-popper';
      x.style.cssText = 'position:fixed;left:420px;top:80px;width:500px;height:340px;background:#191d22';
      x.innerHTML = site === 'gmgn' ? '<div data-sentry-component="TweetContent">原生推文</div>' : '<div class="MuiTooltip-tooltip" style="--twitter-preview-max-height:600px">原生推文</div>';
      document.body.appendChild(x); scanSimilarTokenPanel();
    }, site);
    assert.equal((await rect()).top, 428);
    await page.evaluate(() => { document.querySelector('#native-preview').remove(); scanSimilarTokenPanel(); });
    assert.deepEqual(await rect(), moved);
    pass(`${site}: 拖动位置仍遵守推文避让，关闭推文后回到手动位置`);
    if (process.env.GDH_TEST_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.GDH_TEST_SCREENSHOT_DIR}/v75-${site}-controls.png` });
    await page.locator(close).click();
    await page.evaluate(() => { for (let i = 0; i < 20; i++) scanSimilarTokenPanel(); }); await frame();
    assert.equal(await page.locator(panel).count(), 0);
    assert.deepEqual(await page.evaluate(() => navigation), []);
    assert.equal(await page.evaluate(() => fetchCount), 0);
    assert.equal(await page.evaluate(() => similarTokenRetained.size > 0 && similarTokenXWatches.length === 0 && similarTokenDrag === null), true);
    pass(`${site}: 关闭不触发跳转，连续刷新不重开、不新增请求或清缓存`);
    await page.evaluate(url => { history.pushState({},'',url); scanSimilarTokenPanel(); }, href(addresses[0], 'base'));
    assert.equal(await page.locator(panel).count(), 1);
    await page.locator(close).focus(); await page.keyboard.press('Enter');
    await page.evaluate(() => scanSimilarTokenPanel());
    assert.equal(await page.locator(panel).count(), 0);
    pass(`${site}: 同地址跨链切换可恢复，键盘关闭使用新路由而非旧币`);
    await page.evaluate(() => { settings.enableSimilarTokenPanel = false; scanSimilarTokenPanel(); settings.enableSimilarTokenPanel = true; scanSimilarTokenPanel(); });
    assert.equal(await page.locator(panel).count(), 1);
    assert.deepEqual(await rect(), moved);
    pass(`${site}: 设置关闭再开启可恢复，不丢本页手动位置`);
    const h = await page.locator(header).boundingBox();
    await page.mouse.move(h.x + 40, h.y + 15); await page.mouse.down();
    await page.locator(header).dispatchEvent('pointercancel', { pointerId: 1 });
    await page.mouse.move(h.x + 80, h.y + 50); await page.mouse.up(); await frame();
    assert.deepEqual(await rect(), moved);
    assert.equal(await page.evaluate(() => similarTokenDrag), null);
    await page.locator(prefix + '__row').first().click();
    assert.equal((await page.evaluate(() => navigation)).length, 1);
    assert.equal(await page.locator(prefix + '__row[aria-current="true"]').count(), 1);
    assert.deepEqual(errors, []);
    pass(`${site}: 取消拖动后不粘鼠标，代币点击与当前币高亮正常`);
    await page.close();
  }
  console.log(`1..${checks}`);
} finally { await browser.close(); }
