// Offline DeBot native MUI X preview fixtures; no account, network or settings writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = (name) => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('debot-content.js');
const take = (name) => { const start = source.indexOf(`  function ${name}(`); assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n  }', start) + 4); };
const current = '0x1111111111111111111111111111111111111111';
const peer = '0x2222222222222222222222222222222222222222';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
const pass = (label) => console.log(`PASS ${++checks}: ${label}`);
try {
  const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
    <style>body{background:#101114;color:#eee}#track{position:fixed;left:0;top:80px;width:300px;height:700px}
    .MuiTooltip-popper{position:fixed;left:350px;top:75px;z-index:1500}.MuiTooltip-tooltip{width:600px;height:365px;background:#18191d;border:1px solid #444;border-radius:12px;box-sizing:border-box;overflow:auto}</style>
    <section id="track" data-edge-dock-panel="track"><div data-testid="virtuoso-scroller" style="margin-top:70px">
    <div data-index="0" data-known-size="48"><a href="/token/bsc/invite_${peer}">DARWIN</a></div></div></section>` }));
  await page.goto(`https://debot.ai/token/bsc/invite_${current}`);
  await page.addStyleTag({ content: read('debot-styles.css') });
  await page.addScriptTag({ content: `
    const settings={enabled:true,enableSimilarTokenPanel:true,similarTokenCacheMinutes:5,blockedTokens:[]};
    const FOMO_NETWORK_ID={bsc:56};
    window.fetch=()=>{throw new Error('unexpected request');};
    window.chrome={storage:{local:{set:()=>{throw new Error('unexpected settings write');}}}};
    const syncPanel=()=>{},scheduleFeedLayout=()=>{},scheduleDebotRwaPoolScan=()=>{};
    let feedObserver;
    ${['safeText','validImageUrl','normalizeAddress','debotTokenRoute','debotTokenHref','debotInvitePrefix'].map(take).join('\n')}
    ${source.slice(source.indexOf('  // ---- DeBot 同名 / 相似币'), source.indexOf('  function syncRoute()'))}
    for(const [address,marketCap] of [['${current}',27200],['${peer}',131800]]) {
      similarTokenMetaCache.set(similarTokenMetaKey('bsc',address),{at:Date.now(),data:{chain:'bsc',address,name:'Darwin Gödel Machine',symbol:'DARWIN',marketCap,poolSymbol:'QQQ'}});
    }
    ${source.slice(source.indexOf('    feedObserver = new MutationObserver'), source.indexOf('    feedPollTimer = window.setInterval'))}
    window.addEventListener('resize',scheduleDebotSimilarScan);
    scanSimilarTokenPanel();
    window.makePreview=()=>{const el=document.createElement('div');el.id='preview';el.className='MuiTooltip-popper';el.setAttribute('role','tooltip');
      el.innerHTML='<div class="MuiTooltip-tooltip" style="--twitter-preview-max-height:720px"><div aria-busy="true">正在加载原生推文</div></div>';document.body.appendChild(el);};
  ` });
  const panel = '.gdh-debot-similar-token-panel';
  const rect = () => page.locator(panel).evaluate(e => ({ top: e.getBoundingClientRect().top, left: e.getBoundingClientRect().left, hidden: getComputedStyle(e).visibility === 'hidden' }));
  const at = async (top, hidden = false) => page.waitForFunction(({ panel, top, hidden }) => {
    const el = document.querySelector(panel);
    return el && el.getBoundingClientRect().top === top && (getComputedStyle(el).visibility === 'hidden') === hidden;
  }, { panel, top, hidden }, { timeout: 2000 });
  assert.deepEqual(await rect(), { top: 150, left: 308, hidden: false });
  pass('未打开推文时保持原有定位');
  await page.evaluate(() => makePreview());
  await at(448);
  pass('DeBot MUI 推文尚在加载时就避让到其下方 8px');
  await page.evaluate(() => document.querySelector('.MuiTooltip-tooltip').innerHTML = '<h2>Crank</h2><a href="https://x.com/CrankDeGod/status/123">原生推文</a><p>推文正文与中文翻译</p>');
  await at(448);
  if (process.env.GDH_TEST_SCREENSHOT) await page.screenshot({ path: process.env.GDH_TEST_SCREENSHOT });
  await page.evaluate(() => document.querySelector('.MuiTooltip-tooltip').style.height = '465px');
  await at(548);
  pass('正文、图片或翻译异步变高后跟随');
  await page.evaluate(() => document.querySelector('#preview').style.transform = 'translateY(60px)');
  await at(608);
  pass('原生 Popper transform 位移后自动跟随');
  const writes = await page.evaluate(async () => {
    let n = 0; const observer = new MutationObserver(records => n += records.length);
    observer.observe(similarTokenPanelEl, { attributes: true, childList: true, subtree: true });
    for (let i = 0; i < 10; i++) scanSimilarTokenPanel();
    await Promise.resolve(); observer.disconnect(); return n;
  });
  assert.equal(writes, 0);
  pass('稳定定位零 DOM 改写，不引起自身重复扫描');
  await page.evaluate(() => document.querySelector('.MuiTooltip-tooltip').style.height = '700px');
  await at(843, true);
  assert.equal(await page.locator(panel + ' .gdh-debot-similar-token__row').count(), 2);
  pass('大推文占满视口时临时隐藏相似窗，保留数据和行');
  for (const [property, value] of [['display', 'none'], ['visibility', 'hidden'], ['opacity', '0']]) {
    await page.evaluate(([property, value]) => document.querySelector('.MuiTooltip-tooltip').style[property] = value, [property, value]);
    await at(150);
    await page.evaluate(property => document.querySelector('.MuiTooltip-tooltip').style[property] = '', property);
    await at(843, true);
  }
  pass('原生预览隐藏或淡出后及时恢复');
  await page.evaluate(() => document.querySelector('#preview').remove());
  await at(150);
  pass('关闭推文自动复位，不删除相似币缓存');
  await page.evaluate(() => {
    const el = document.createElement('div'); el.id = 'unrelated'; el.className = 'MuiTooltip-popper'; el.setAttribute('role', 'tooltip');
    el.innerHTML = '<div class="MuiTooltip-tooltip">普通提示</div>'; document.body.appendChild(el); scanSimilarTokenPanel();
  });
  assert.equal((await rect()).top, 150);
  pass('普通提示不触发避让');
  await page.evaluate(() => { document.querySelector('#unrelated').remove(); makePreview(); document.querySelector('#preview').style.left = '950px'; });
  await at(150);
  pass('横向不相交的推文不移动相似窗');
  await page.evaluate(() => { document.querySelector('#preview').style.left = '350px'; });
  await at(448);
  await page.evaluate(() => {
    document.querySelector('.MuiTooltip-tooltip').style.removeProperty('--twitter-preview-max-height');
    document.querySelector('.MuiTooltip-tooltip').innerHTML = '<a href="https://twitter.com/test/status/123">原生 X 预览</a>';
  });
  await at(448);
  pass('带 X 链接的原生预览兼容旧版结构');
  await page.evaluate(() => { document.querySelector('#preview').remove(); });
  await at(150);
  const href = await page.evaluate(() => {
    let href; document.addEventListener('gdh-debot-navigate', e => href = e.detail.href, { once: true });
    document.querySelector('.gdh-debot-similar-token__row').click(); return href;
  });
  assert.ok(href.includes(peer));
  assert.equal(await page.locator(panel + ' [aria-current="true"]').count(), 1);
  pass('避让后仍保留当前币高亮与站内导航事件');
  await page.evaluate(() => { settings.enableSimilarTokenPanel = false; scanSimilarTokenPanel(); makePreview(); });
  assert.equal(await page.locator(panel).count(), 0);
  assert.equal(await page.evaluate(() => similarTokenXWatches.length), 0);
  pass('功能关闭后移除浮窗并释放局部监听');
  console.log(`1..${checks}`);
} finally { await browser.close(); }
