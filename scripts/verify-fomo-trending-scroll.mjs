// Replay production functions in an offline browser; never touch live trading tabs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.BGM_TEST_SOURCE || fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const source = read('content.js');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const take = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const names = ['fomoTrendingMount', 'setFomoTrendingTabTone', 'deactivateFomoTrending', 'removeFomoTrendingUi', 'fomoTrendingMoney', 'fomoTrendingPrice', 'fomoTrendingBlockKey', 'getFomoTrendingBlockedTokens', 'isFomoTrendingBlocked', 'persistFomoTrendingBlockedTokens', 'blockFomoTrendingToken', 'renderFomoTrendingPanel', 'pollFomoTrending', 'activateFomoTrending', 'scanFomoTrendingTab'];
const items = Array.from({ length: 80 }, (_, i) => ({ networkId: 56, address: '0x' + (i + 1).toString(16).padStart(40, '0'), symbol: 'TOKEN' + i, priceUsd: .01, marketCapUsd: 100000 + i, change24Ratio: .2 }));
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); console.log(`PASS ${++checks}: ${label}`); };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#111;color:white;font:12px Arial}main{display:flex;flex-direction:column;width:360px;height:600px}nav{height:35px;display:flex;gap:15px}nav>div{cursor:pointer}.native-body{flex:1}</style><main data-sentry-component="Main"><nav><div data-testid="filter-tag-trending">Hot</div><div>Favorites</div></nav><div class="native-body">Native content untouched</div></main>`);
  await page.addStyleTag({ content: read('styles.css') });
  const script = `
    let settings={enableFomoTrending:true,fomoTrendingBlockedTokens:[]};
    let fomoTrendingActive=false,fomoTrendingLoading=false,fomoTrendingItems=${JSON.stringify(items)},fomoTrendingError='',fomoTrendingFetchedAt=Date.now(),fomoTrendingPanelEl=null,fomoTrendingTabEl=null,fomoTrendingNativeBody=null;
    const FOMO_TRENDING_REFRESH_MS=60000;
    ${source.match(/const FOMO_GMGN_CHAIN = [^\n]+/)[0]}
    window.requests=[];window.saved={};window.navigated='';window.opened=[];
    const chrome={runtime:{sendMessage(message,cb){requests.push({message,cb})}},storage:{local:{set(values,cb){Object.assign(saved,values);cb?.()}}}};
    const isFomoTrendingFooterActive=()=>false,renderFomoTrendingFooter=()=>{},gdhSpaNavigate=href=>{navigated=href};
    window.open=url=>{opened.push(url);return null};
    ${names.map(name => take(source, name)).join('\n')}
    window.list=()=>document.querySelector('.gdh-fomo-trending__list');
    window.rows=()=>[...document.querySelectorAll('.gdh-fomo-trending__row')];
    window.api={
      response(items){requests.at(-1).cb({ok:true,items,at:Date.now()+1000})},
      error(reason){requests.at(-1).cb({ok:false,reason})},
      reset(){settings.fomoTrendingBlockedTokens=[];fomoTrendingItems=${JSON.stringify(items)};fomoTrendingFetchedAt=Date.now();fomoTrendingError='';renderFomoTrendingPanel()},
      scroll(y){list().scrollTop=y;window.oldList=list();window.oldRow=rows()[20];return list().scrollTop},
      snapshot(){return {top:list()?.scrollTop,sameList:list()===oldList,sameRow:rows()[20]===oldRow}},
      disable(){settings.enableFomoTrending=false;scanFomoTrendingTab()},
      enable(){settings.enableFomoTrending=true;scanFomoTrendingTab()}
    };
    scanFomoTrendingTab();document.querySelector('[data-testid="gdh-fomo-trending"]').click();
  `;
  new vm.Script(script);
  await page.addScriptTag({ content: script });
  check(await page.locator('.gdh-fomo-trending__row').count() === 80, 'long hot list renders');
  const before = await page.evaluate(() => api.scroll(832));
  await page.evaluate(() => { for(let i=0;i<30;i++) scanFomoTrendingTab(); });
  const after = await page.evaluate(() => api.snapshot());
  console.log('scroll-replay', JSON.stringify({ before, after }));
  check(after.top === before && before > 0, 'repeated page scans never reset scrollTop');
  check(after.sameList && after.sameRow, 'unchanged scans retain scroller and rows');
  check(await page.evaluate(() => requests.length === 0), 'unchanged scans honor existing 60 second cache');

  await page.evaluate(() => {pollFomoTrending(true);pollFomoTrending(true)});
  check(await page.evaluate(() => requests.length === 1), 'refresh requests remain single-flight');
  check(await page.evaluate(() => api.snapshot().sameRow && list().scrollTop === 832), 'loading with cached rows does not rewrite the list');
  const changed = items.map(item => ({...item,marketCapUsd:2000000,priceUsd:.1234}));
  await page.evaluate(data => api.response(data), changed);
  check(await page.evaluate(() => api.snapshot().sameList && list().scrollTop === 832), 'new prices retain the same scroll container and position');
  check(await page.locator('.gdh-fomo-trending__stats strong').first().textContent() === '$2.00M MC', 'market cap still updates');
  check((await page.locator('.gdh-fomo-trending__identity').first().textContent()).includes('$0.1234'), 'token price still updates');
  for (const y of [1300,1700,2150]) {
    await page.evaluate(y => {api.scroll(y);pollFomoTrending(true)}, y);
    await page.evaluate(data => api.response(data), changed.slice().reverse());
    check(await page.evaluate(y => list().scrollTop === y && list() === oldList, y), `refresh while browsing preserves ${y}px`);
  }
  await page.evaluate(() => {api.scroll(1040);document.querySelector('[data-testid="filter-tag-trending"]').click();pollFomoTrending(true)});
  await page.evaluate(data => api.response(data), items);
  check(await page.locator('.native-body').isVisible(), 'native tab remains usable while data updates');
  await page.locator('[data-testid="gdh-fomo-trending"]').click();
  check(await page.evaluate(() => list().scrollTop === 1040 && list() === oldList), 'returning from native tab retains position even after hidden refresh');
  check(await page.locator('.gdh-fomo-trending__identity strong').first().textContent() === 'TOKEN0', 'reopening applies latest cached data');

  await page.evaluate(() => {api.scroll(1040);document.querySelector('main').style.display='none';pollFomoTrending(true)});
  await page.evaluate(data => api.response(data), changed);
  await page.evaluate(() => {document.querySelector('main').style.display='';scanFomoTrendingTab()});
  check(await page.evaluate(() => list().scrollTop === 1040 && list() === oldList), 'hidden parent panel retains scroll through background refresh');
  check(await page.locator('.gdh-fomo-trending__stats strong').first().textContent() === '$2.00M MC', 'showing parent panel applies latest data');

  await page.evaluate(() => {api.scroll(832);rows()[0].querySelector('button').click()});
  check(await page.evaluate(() => list().scrollTop === 832 && list() === oldList), 'blocking a token retains scroll position');
  check(await page.locator('.gdh-fomo-trending__row').count() === 79, 'blocked token is removed');
  check(await page.evaluate(() => saved.fomoTrendingBlockedTokens.length === 1 && !navigated), 'block persists without navigating');
  await page.locator('.gdh-fomo-trending__meta-actions button').click();
  check(await page.evaluate(() => list().scrollTop === 832 && rows().length === 80), 'restore all retains scroll position');
  await page.evaluate(() => {api.scroll(99999);pollFomoTrending(true)});
  await page.evaluate(data => api.response(data), items.slice(0,40));
  check(await page.evaluate(() => list().scrollTop > 0 && list().scrollTop === list().scrollHeight-list().clientHeight), 'shorter result clamps to bottom instead of jumping to top');

  await page.evaluate(() => {api.scroll(600);pollFomoTrending(true);api.error('expired')});
  check(await page.evaluate(() => list().scrollTop === 600 && rows().length === 40 && !opened.length), 'failed refresh retains cached rows without opening login tabs');
  await page.evaluate(() => {pollFomoTrending(true);api.response([])});
  check(await page.locator('.gdh-fomo-trending__row').count() === 0, 'genuine empty response clears stale results');
  await page.evaluate(() => {pollFomoTrending(true)});
  check((await page.locator('.gdh-fomo-trending__state').textContent()).includes('正在读取'), 'empty first-load state renders');
  await page.evaluate(() => api.error('expired'));
  check((await page.locator('.gdh-fomo-trending__state').textContent()).includes('需要登录'), 'no-data login error still renders');
  await page.evaluate(() => api.reset());
  await page.evaluate(() => persistFomoTrendingBlockedTokens(fomoTrendingItems.map(item=>({key:fomoTrendingBlockKey(item.networkId,item.address)}))));
  check((await page.locator('.gdh-fomo-trending__state').textContent()).includes('均已屏蔽'), 'all-blocked state replaces the list');
  await page.locator('.gdh-fomo-trending__meta-actions button').click();
  check(await page.locator('.gdh-fomo-trending__row').count() === 80, 'all-blocked list can be restored');
  await page.evaluate(() => {rows()[2].click()});
  check(await page.evaluate(() => navigated.endsWith('/' + fomoTrendingItems[2].address)), 'click navigation remains intact');
  await page.evaluate(() => {api.disable();api.enable();document.querySelector('[data-testid="gdh-fomo-trending"]').click()});
  check(await page.locator('.gdh-fomo-trending__row').count() === 80 && await page.locator('.gdh-fomo-trending-panel').count() === 1, 'remount renders once even when data is unchanged');
  check(!errors.length, 'no browser runtime errors');
  console.log(`FOMO trending scroll: ${checks} checks passed`);
} finally { await browser.close(); }
