// Offline production-function replay; no real wallets, FOMO login or API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.BGM_TEST_SOURCE || fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const source = read('content.js'), monitor = read('monitor-aggregate.js'), popup = read('popup.js');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const take = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); console.log(`PASS ${++checks}: ${label}`); };
const A = '0x' + 'ab'.repeat(20), B = '0x' + 'cd'.repeat(20), SOL = 'So11111111111111111111111111111111111111112';
const rows = name => Array.from({ length: 6 }, (_, i) => ({ name: `${name}${i}`, holdingPercent: 6 - i, profit: 100 + i, profitPercent: 0.1, avatar: '' }));
const items = Array.from({ length: 30 }, (_, i) => ({ networkId: 56, address: '0x' + (i + 1).toString(16).padStart(40, '0'), symbol: 'TOKEN' + i, name: 'Fixture Token ' + i, marketCapUsd: 1000000 + i * 10, priceUsd: 0.001, change24Ratio: i % 2 ? -0.2 : 0.3 }));
items[0] = { ...items[0], symbol: 'ARC', networkId: 5042, address: A };
items[1] = { ...items[1], symbol: 'SOL', networkId: 1399811149, address: SOL, marketCapUsd: null, priceUsd: null, change24Ratio: null };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const footer = `<footer><div class="native-lane"><div class="native-controls"><button id="native-holding" data-testid="holding-float-toggle">Holdings</button><button>Favorites</button><button>Trading</button><button>Trending</button><button>BTC $84.6K</button><button>SOL $119.17</button><button>BNB $768.55</button></div></div><div class="native-status"><div data-sentry-component="WsStatusCom">Stable · 60 FPS</div><button>About</button></div></footer>`;
async function setup(saved = {}) {
  const page = await browser.newPage({ viewport: { width: 2200, height: 850 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<style>
    *{box-sizing:border-box}body{margin:0;background:#111;color:#ccc;font:12px Arial}
    #chart{position:relative;margin:40px;width:650px;height:350px}.chart-anchor-main{position:absolute;inset:0;background:#17191d;z-index:800}
    footer{display:flex;gap:12px;justify-content:space-between;position:fixed;bottom:0;width:100%;height:36px;padding:0 6px;border-top:1px solid #333;overflow:hidden}
    .native-lane{display:flex;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}.native-controls{display:flex;align-items:center;gap:4px;width:1138px}
    .native-controls button{flex:none;white-space:nowrap}.native-status{display:flex;gap:4px;align-items:center;flex-shrink:0;width:280px}
    button{background:#222;color:inherit;border:1px solid #444;padding:3px 8px}
    </style><div id="chart"><div class="chart-anchor-main">Chart hit-test surface</div></div>${footer}` }));
  await page.goto('https://gmgn.ai/bsc/token/' + A);
  await page.addStyleTag({ content: read('styles.css') + '\n' + read('monitor-aggregate.css') });
  const closeStart = source.indexOf("  document.addEventListener('gdh-chart-holdings-close'");
  assert.ok(closeStart >= 0, 'close action must be connected to extension storage');
  const closeListener = source.slice(closeStart, source.indexOf('\n  });', closeStart) + 6);
  const monitorNames = ['formatSignedMoney', 'formatSignedPercent', 'currentTokenRoute', 'removeChartHoldings', 'isChartHoldingsEnabled', 'closeChartHoldings', 'renderChartHoldings', 'refreshChartHoldings', 'scanChartHoldings'];
  const footerNames = ['fomoTrendingFooterMount', 'isFomoTrendingFooterActive', 'removeFomoTrendingFooter', 'fomoTrendingTokenHref', 'renderFomoTrendingFooter', 'scanFomoTrendingFooter', 'fomoTrendingMoney', 'fomoTrendingPrice', 'fomoTrendingBlockKey', 'getFomoTrendingBlockedTokens', 'isFomoTrendingBlocked', 'persistFomoTrendingBlockedTokens', 'pollFomoTrending'];
  const js = `
    let settings={enableChartTrackedHoldings:true,enableMonitorAggregate:false,enableFomoTrending:false,enableFomoTrendingFooter:false,...${JSON.stringify(saved)}};
    window.saved=${JSON.stringify(saved)};window.holderRequests=[];window.fomoRequests=[];window.navigated='';window.opened=[];
    const chrome={runtime:{sendMessage(message,cb){fomoRequests.push({message,cb})}},storage:{local:{set(values,cb){Object.assign(window.saved,values);cb?.()}}}};
    const MONITOR_AGGREGATE_ATTR='data-gdh-monitor-aggregate-enabled',CHART_HOLDINGS_CONFIG_ATTR='data-gdh-chart-holdings-enabled',CHART_HOLDINGS_SELECTOR='.chart-anchor-main',CHART_HOLDINGS_TTL_MS=30000;
    let chartHoldingsInflight=null,chartHoldingsKey='',chartHoldingsFetchedAt=0,chartHoldingsGeneration=0;
    const trackedHolderApi=(chain,address)=>new Promise((resolve,reject)=>holderRequests.push({chain,address,resolve,reject}));
    const discoverTrackedHolderApi=()=>true,extractTrackedHoldingRows=r=>r.list,readTrackedHoldingMarks=()=>new Map(),applyTrackedHoldingMark=x=>x,sanitizeTrackedHolding=x=>x;
    const escapeHtml=x=>{const e=document.createElement('span');e.textContent=x;return e.innerHTML};
    ${monitorNames.map(n => take(monitor, n)).join('\n')}
    ${take(source, 'syncMonitorAggregateSetting')}
    ${closeListener}
    document.addEventListener('gdh-monitor-config-changed',scanChartHoldings);
    ${source.match(/const FOMO_GMGN_CHAIN = [^\n]+/)[0]}
    const FOMO_TRENDING_REFRESH_MS=60000;
    let fomoTrendingFooterEl=null,fomoTrendingFooterLane=null,fomoTrendingActive=false,fomoTrendingLoading=false,fomoTrendingItems=[],fomoTrendingError='',fomoTrendingFetchedAt=0;
    let panelRenders=0;const renderFomoTrendingPanel=()=>panelRenders++;
    const gdhSpaNavigate=href=>{window.navigated=href};window.open=url=>{opened.push(url);return null};
    ${footerNames.map(n => take(source, n)).join('\n')}
    window.api={
      tracked(on){settings.enableChartTrackedHoldings=on;syncMonitorAggregateSetting()},
      route(address){history.replaceState({},'', '/bsc/token/'+address);scanChartHoldings()},
      footer(on){settings.enableFomoTrendingFooter=on;scanFomoTrendingFooter()},
      response(index,response){fomoRequests[index].cb(response)},
      expire(){fomoTrendingFetchedAt=0},
      panel(on){fomoTrendingActive=on},
      block(item){persistFomoTrendingBlockedTokens([{key:fomoTrendingBlockKey(item.networkId,item.address)}])},
      seed(items){fomoTrendingItems=items;fomoTrendingFetchedAt=Date.now();fomoTrendingError='';renderFomoTrendingFooter()},
      layout(){return [...document.querySelectorAll('.native-controls,.native-controls button,.native-status')].map(e=>({x:e.getBoundingClientRect().x,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}))}
    };`;
  new vm.Script(js);
  await page.addScriptTag({ content: js });
  return page;
}
try {
  const page = await setup();
  await page.evaluate(() => scanChartHoldings());
  check(await page.evaluate(() => holderRequests.length === 0), 'no request before saved settings reach MAIN');
  await page.evaluate(() => api.tracked(false));
  check(await page.evaluate(() => holderRequests.length === 0), 'disabled setting does not call holder API');
  await page.evaluate(() => api.tracked(true));
  await page.evaluate(rows => holderRequests[0].resolve({ list: rows }), rows('Alice'));
  await page.waitForSelector('.gdh-chart-tracked-close');
  check(await page.locator('.gdh-chart-tracked-holder').count() === 5, 'existing top-five display preserved with aggregate disabled');
  check(await page.evaluate(() => {const e=document.querySelector('.gdh-chart-tracked-holder'),r=e.getBoundingClientRect();return document.elementFromPoint(r.x+30,r.y+5).classList.contains('chart-anchor-main')}), 'holding text does not intercept chart gestures');
  await page.locator('.gdh-chart-tracked-close').click();
  check(await page.evaluate(() => !document.querySelector('.gdh-chart-tracked-holdings') && saved.enableChartTrackedHoldings === false), 'close button immediately removes overlay and persists disabled switch');
  await page.evaluate(B => {for(let i=0;i<10;i++)scanChartHoldings();api.route(B)}, B);
  check(await page.evaluate(() => holderRequests.length === 1), 'disabled remains quiet over repeated scans and token navigation');
  const fresh = await setup(await page.evaluate(() => saved));
  await fresh.evaluate(() => syncMonitorAggregateSetting());
  check(await fresh.evaluate(() => holderRequests.length === 0), 'new document respects persisted disabled preference');
  await fresh.close();
  await page.evaluate(() => {api.tracked(true);api.tracked(false);api.tracked(true)});
  await page.evaluate(rows => holderRequests[2].resolve({ list: rows }), rows('New'));
  await page.waitForFunction(() => document.querySelector('.gdh-chart-tracked-holdings')?.textContent.includes('New0'));
  await page.evaluate(rows => holderRequests[1].resolve({ list: rows }), rows('Stale'));
  check(await page.locator('.gdh-chart-tracked-holdings').textContent().then(t=>t.includes('New0')&&!t.includes('Stale')), 'late result from before close/reopen cannot overwrite new holdings');
  await page.evaluate(() => {api.tracked(false);api.tracked(true);api.tracked(false);api.tracked(true)});
  await page.evaluate(rows => holderRequests[4].resolve({ list: rows }), rows('Latest'));
  await page.waitForFunction(() => document.querySelector('.gdh-chart-tracked-holdings')?.textContent.includes('Latest0'));
  await page.evaluate(() => holderRequests[3].reject(new Error('late failure')));
  check(await page.locator('.gdh-chart-tracked-holdings').count() === 1, 'late failed request cannot remove newly rendered overlay');
  await page.locator('.gdh-chart-tracked-close').click();
  await page.evaluate(() => api.tracked(true));
  await page.evaluate(() => holderRequests[5].resolve({ list: [] }));
  await page.waitForSelector('.gdh-chart-tracked-holdings.is-empty');
  check(await page.locator('.gdh-chart-tracked-close').isVisible(), 'empty holdings state can also be closed');
  await page.locator('.gdh-chart-tracked-close').click();

  await page.evaluate(() => scanFomoTrendingFooter());
  check(await page.evaluate(() => !document.querySelector('.gdh-fomo-footer') && fomoRequests.length===0), 'footer defaults off, creates no DOM and sends no request');
  const before = await page.evaluate(() => api.layout());
  await page.evaluate(() => {api.footer(true);api.panel(true);pollFomoTrending();api.panel(false)});
  check(await page.evaluate(() => fomoRequests.length===1), 'footer works with native FOMO tab disabled and coalesces concurrent panel polling');
  await page.evaluate(items => api.response(0,{ok:true,items,at:Date.now()}), items);
  check(await page.locator('.gdh-fomo-footer__token').count()===30, 'footer displays the existing trending result order');
  check(JSON.stringify(before) === JSON.stringify(await page.evaluate(() => api.layout())), 'native footer controls/prices/status positions are unchanged');
  check(await page.locator('.gdh-fomo-footer__token').nth(1).textContent().then(t=>t==='SOL——'), 'unknown market cap and percentage are not rendered as zero');
  await page.locator('.gdh-fomo-footer__token').first().click();
  check(await page.evaluate(A => navigated==='/arc/token/'+A,A), 'footer click uses existing SPA navigation including Arc');
  check(await page.locator('.gdh-fomo-footer__token').nth(1).getAttribute('href')==='/sol/token/'+SOL, 'Solana navigation preserves case');
  check(await page.evaluate(() => {
    navigated='';const e=new MouseEvent('click',{bubbles:true,cancelable:true,ctrlKey:true});document.querySelector('.gdh-fomo-footer__token').dispatchEvent(e);return !e.defaultPrevented&&!navigated;
  }), 'Ctrl click leaves native new-tab behavior intact');
  check(await page.evaluate(async () => {
    let n=0;const o=new MutationObserver(ms=>n+=ms.length);o.observe(document.querySelector('.gdh-fomo-footer'),{attributes:true,subtree:true,childList:true,characterData:true});scanFomoTrendingFooter();scanFomoTrendingFooter();await Promise.resolve();o.disconnect();return n===0&&fomoRequests.length===1;
  }), 'unchanged scan does no footer DOM writes or extra requests');
  await page.evaluate(item => api.block(item), items[0]);
  check(await page.locator('.gdh-fomo-footer__token').count()===29 && !await page.locator('.gdh-fomo-footer__token').first().textContent().then(t=>t.includes('ARC')), 'existing trending-token blacklist immediately filters footer');
  await page.evaluate(() => persistFomoTrendingBlockedTokens([]));
  await page.evaluate(() => {const l=document.querySelector('.gdh-fomo-footer__list');l.scrollLeft=200});
  await page.evaluate(items => api.seed(items.map(x=>({...x,marketCapUsd:9900000}))), items);
  check(await page.evaluate(() => document.querySelector('.gdh-fomo-footer__list').scrollLeft===200), 'data refresh keeps horizontal scroll position');
  check(await page.locator('.gdh-fomo-footer__token').first().textContent().then(t=>t.includes('$9.90M')), 'new cached market cap is displayed');
  await page.evaluate(() => {api.expire();pollFomoTrending()});
  check(await page.evaluate(() => fomoRequests.length===2), 'shared 60-second refresh can request new data');
  await page.evaluate(() => api.response(1,{ok:false,reason:'expired'}));
  check(await page.locator('.gdh-fomo-footer__state').textContent()==='Cached' && await page.locator('.gdh-fomo-footer__token').count()===30, 'expired login retains last data with explicit cached warning');
  check(await page.evaluate(() => opened.length===0), 'expired login never automatically opens FOMO windows');
  await page.locator('.gdh-fomo-footer__state').click();
  check(await page.evaluate(() => opened[0]==='https://fomo.family/'), 'sign-in window opens only after explicit user click');
  await page.evaluate(() => {api.expire();Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});scanFomoTrendingFooter()});
  check(await page.evaluate(() => fomoRequests.length===2), 'hidden footer-only page pauses polling');
  await page.evaluate(() => {Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});api.expire();pollFomoTrending();api.footer(false)});
  await page.evaluate(items => api.response(2,{ok:true,items,at:Date.now()}),items);
  check(await page.locator('.gdh-fomo-footer').count()===0, 'late FOMO response cannot recreate disabled footer');
  check(await page.locator('.gdh-fomo-footer-lane').count()===0, 'disabled footer restores native lane layout class');
  await page.evaluate(() => {scanFomoTrendingFooter();api.expire();pollFomoTrending()});
  check(await page.evaluate(() => fomoRequests.length===3), 'both display consumers off means no trending polling');
  await page.evaluate(() => api.footer(true));
  await page.evaluate(items => api.response(3,{ok:true,items,at:Date.now()}),items);
  for (const width of [1590,3200]) {
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>api.footer(false));
    const nativeLayout=await page.evaluate(()=>api.layout());
    await page.evaluate(()=>api.footer(true));
    check(JSON.stringify(nativeLayout)===JSON.stringify(await page.evaluate(()=>api.layout())),`desktop ${width}px preserves native controls' natural width`);
    check(await page.evaluate(() => {
      const bar=document.querySelector('.gdh-fomo-footer'),lane=bar.parentElement,f=lane.parentElement,status=f.lastElementChild;
      const b=bar.getBoundingClientRect(),l=lane.getBoundingClientRect(),s=status.getBoundingClientRect();
      return b.height<=f.clientHeight&&b.top>=f.getBoundingClientRect().top&&l.right<=s.left&&s.right<=innerWidth;
    }), `desktop ${width}px native footer keeps status visible and clips only within native scroller`);
  }
  await page.evaluate(() => {const lane=document.querySelector('.native-lane');lane.querySelector('.gdh-fomo-footer').remove();scanFomoTrendingFooter()});
  check(await page.locator('.gdh-fomo-footer').count()===1, 'native rerender remounts one footer using cached data');
  await page.evaluate(() => {document.querySelector('footer').remove();scanFomoTrendingFooter();api.expire();pollFomoTrending()});
  check(await page.evaluate(() => fomoRequests.length===4), 'unknown or absent native footer does not start requests');
  await page.evaluate(footer => {document.body.insertAdjacentHTML('beforeend',footer);scanFomoTrendingFooter()},footer);
  await page.evaluate(items => api.response(4,{ok:true,items,at:Date.now()}),items);
  await page.evaluate(() => api.tracked(true));
  await page.evaluate(rows => holderRequests[6].resolve({list:rows}),rows('Tracked'));
  await page.waitForSelector('.gdh-chart-tracked-holdings');
  fs.mkdirSync(new URL('../dist/',import.meta.url),{recursive:true});
  await page.screenshot({path:fileURLToPath(new URL('../dist/v119-controls-footer.png',import.meta.url))});

  const pop = await browser.newPage();
  await pop.route('**/*',route=>route.abort());
  await pop.setContent(read('popup.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
  const defs=popup.slice(popup.indexOf('const DEFAULTS ='),popup.indexOf('const devListInput ='));
  const cbStart=popup.indexOf('chrome.storage.onChanged.addListener((changes, areaName) => {');
  const changeListener=popup.slice(cbStart,popup.indexOf('\n});',cbStart)+4);
  await pop.addScriptTag({content:`window.changeListeners=[];const chrome={storage:{onChanged:{addListener:f=>changeListeners.push(f)}}};${defs};for(const [key,input] of Object.entries(featureInputs))input.checked=DEFAULTS[key]!==false;${changeListener}`});
  check(await pop.locator('#enable-chart-tracked-holdings').isChecked()&&!await pop.locator('#enable-fomo-trending-footer').isChecked(),'settings preserve existing holdings-on and new footer-off defaults');
  await pop.evaluate(()=>changeListeners[0]({enableChartTrackedHoldings:{newValue:false},enableFomoTrendingFooter:{newValue:true}},'local'));
  check(!await pop.locator('#enable-chart-tracked-holdings').isChecked()&&await pop.locator('#enable-fomo-trending-footer').isChecked(),'already-open settings reflects close/changes from another page');
  check(await pop.locator('label:has(#enable-chart-tracked-holdings) .new-badge').count()===1&&await pop.locator('label:has(#enable-fomo-trending-footer) .new-badge').count()===1,'both new settings have NEW labels');
  check(errors.length===0,'no browser exceptions: '+errors.join(';'));
  console.log(`Chart holdings and footer: ${checks} checks passed`);
} finally {await browser.close()}
