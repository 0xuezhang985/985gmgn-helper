// Production FOMO click + cross-world bridge in an isolated browser, no accounts / APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const content = read('content.js'), bridge = read('page-bridge.js'), background = read('background.js');
const take = name => { const start = content.indexOf(`function ${name}(`); assert.ok(start >= 0); return content.slice(start, content.indexOf('\n  }', start) + 4); };
const navBridge = bridge.slice(bridge.indexOf("  document.addEventListener('gdh-navigate',"), bridge.lastIndexOf('})();'));
const normalizeFeed = [
  background.match(/const FOMO_CHAIN_SLUG = [^;]+;/)[0],
  background.match(/const FOMO_FEED_TYPE = [\s\S]*?\n};/)[0],
  background.slice(background.indexOf('function slimFomoEvent('), background.indexOf('\nasync function fetchFomoFeed(')),
].join('\n');
const browser = await chromium.launch({ headless: true });
let checks = 0; const pass = text => console.log(`PASS ${++checks}: ${text}`);
try {
  for (const [input, expected] of [
    ['chain5042', 'arc'], [' Chain5042 ', 'arc'], ['chain 5042', 'arc'], ['Arc', 'arc'],
    ['bnb', 'bsc'], ['ethereum', 'eth'], ['solana', 'sol'], ['robinhood', 'robinhood'],
    ['chain 143', 'monad'], ['chain999999', 'chain999999'],
  ]) {
    const event = vm.runInNewContext(`${normalizeFeed};slimFomoEvent(raw)`, {
      raw: { eventType: 'FOMO_BUY', chainName: input, tokenAddress: '0x' + '2'.repeat(40), ts: Date.now() },
    });
    assert.equal(event.chain, expected, `chainName=${input}`);
    assert.equal(event.addr, '0x' + '2'.repeat(40));
  }
  pass('生产推送归一化识别 chain5042 / Arc，保留合约及其他链，不猜测未知链');
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<html><body><main>原生图表</main></body></html>' }));
  await page.goto('https://gmgn.ai/bsc/token/0x' + '1'.repeat(40));
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.addScriptTag({ content: `
    window.routerCalls=[]; window.navigationErrors=0;
    document.addEventListener('gdh-navigation-error',()=>navigationErrors++);
    window.next={router:{push:async path=>{routerCalls.push(path);await new Promise(r=>setTimeout(r,1200));history.pushState({},'',path);return true;}}};
    const fomoFeedSeen=new Set(), FOMO_FEED_SEEN_MAX=100;
    const rememberBoundedSet=(set,key)=>set.add(key);
    ${bridge.match(/const GDH_NAV_RE = [^;]+;/)[0]}
    ${take('gdhSpaNavigate')}
    ${take('attachFomoFeedCardBehavior')}
    ${navBridge}
    ${normalizeFeed}
    const card=document.createElement('div'); card.id='fomo-arc'; card.textContent='FOMO Arc 代币';
    attachFomoFeedCardBehavior(slimFomoEvent({eventType:'FOMO_BUY',chainName:'chain5042',tokenAddress:'0x'+'2'.repeat(40),symbol:'ARC',key:'arc-test',ts:Date.now()}),card);
    document.body.appendChild(card);
  ` });
  await page.locator('#fomo-arc').click();
  await page.waitForURL('**/arc/token/0x' + '2'.repeat(40));
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  assert.equal(await page.locator('#fomo-arc').count(), 1);
  pass('chain5042 原始推送经生产转换和卡片点击跨链进入 Arc，1.2 秒慢路由仍不整页刷新');
  await page.evaluate(() => gdhSpaNavigate('/arc/token/0x' + '3'.repeat(40)));
  await page.waitForURL('**/arc/token/0x' + '3'.repeat(40));
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  pass('热门榜共用入口默认也使用 SPA，Arc 链内跳转保留页面实例');
  await page.evaluate(() => { window.next.router.push=()=>Promise.reject(new Error('route failed')); gdhSpaNavigate('/arc/token/0x'+'4'.repeat(40)); });
  await page.waitForFunction(() => navigationErrors === 1);
  assert.ok(page.url().endsWith('3'.repeat(40)));
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  pass('路由拒绝时发送已有错误提示，不刷新、不擅自改到其他代币');
  await page.evaluate(() => { window.next={}; gdhSpaNavigate('/arc/token/0x'+'4'.repeat(40)); });
  assert.equal(await page.evaluate(() => navigationErrors), 2);
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  pass('路由尚未就绪时安全提示，不回退整页导航');
  await page.evaluate(() => {
    window.next={router:{push:path=>routerCalls.push(path)}};
    gdhSpaNavigate(location.pathname);
    document.documentElement.setAttribute('data-gdh-nav','https://example.com/');
    document.dispatchEvent(new Event('gdh-navigate'));
  });
  assert.equal(await page.evaluate(() => routerCalls.length), 2);
  assert.deepEqual(errors, []);
  pass('已在目标页不重复跳转，跨站地址被桥接白名单拒绝，无脚本异常');
  console.log(`SPA navigation: ${checks} checks passed`);
} finally { await browser.close(); }
