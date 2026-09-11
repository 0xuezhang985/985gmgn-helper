// Offline retention/lifecycle regression. Does not open a user profile or request account data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baseline = process.argv.includes('--baseline');
const read = (name) => (baseline ? execFileSync('git', ['show', `v0.46.65:${name}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n');
const content = read('content.js');
const take = (name) => { const start = content.indexOf(`function ${name}(`); return content.slice(start, content.indexOf('\n  }', start) + 4); };
const current = '0x1111111111111111111111111111111111111111';
const peer = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let passed = 0;
const pass = (label) => console.log(`PASS retention ${++passed}: ${label}`);
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <style>#tracker{position:fixed;left:400px;top:50px;width:350px;height:500px}.row{display:block;height:44px}</style>
    <section id="tracker"><button data-testid="follow-tracking-tab">追踪</button><div id="tracking-body">
    <a class="row" href="/robinhood/token/${peer}">FLYBOOK</a></div></section>` }));
  await page.goto(`https://gmgn.ai/base/token/${current}`);
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    const settings={enableSimilarTokenPanel:true,similarTokenCacheMinutes:5};
    const TRACK_TAB_CELL='[data-testid="follow-tracking-tab"]';
    const trackerCards=()=>[...document.querySelectorAll('#tracker .row')];
    const currentTokenRoute=()=>{const m=location.pathname.match(/^\\/(\\w+)\\/token\\/(\\w+)/);return m?{chain:m[1],address:m[2]}:null;};
    const gmgnApiQuery=()=>'';const scheduleScan=()=>{};const gdhSpaNavigate=()=>{};
    window.blocked=new Set();const isTokenBlocked=(address,chain)=>blocked.has(chain+'|'+address);
    window.now=1000000;Date.now=()=>window.now;window.requests=[];
    ${take('trackingFeedNormalizedAddress')}
    ${take('setBoundedMap')}
    ${content.slice(content.indexOf('  const SIMILAR_TOKEN_META_TTL'), content.indexOf('  function requestStonkfunRwaCatalog'))}
    const originalRequest=requestSimilarTokenMeta;
    requestSimilarTokenMeta=(entries)=>{requests.push(entries);return originalRequest(entries);};
    const put=(chain,address,name,symbol,marketCap,poolSymbol)=>similarTokenMetaCache.set(similarTokenMetaKey(chain,address),{at:Date.now(),data:{chain,address,name,symbol,marketCap,poolSymbol}});
    put('base','${current}','The Flybook','FLYBOOK',200000,'WETH');
    put('robinhood','${peer}','flybook','FLYBOOK',130000,'GOOGL');
    put('base','${other}','Completely Different','DIFFERENT',600000,'WETH');
    window.peerEl=document.querySelector('.row');
    window.seed=()=>{
      history.replaceState({},'','/base/token/${current}');
      settings.enableSimilarTokenPanel=true;settings.similarTokenCacheMinutes=5;blocked.clear();
      similarTokenRetained.clear();document.querySelector('#tracker').style.display='';
      document.querySelector('#tracking-body').appendChild(peerEl);scanSimilarTokenPanel();
    };
    scanSimilarTokenPanel();
  ` });
  const count = () => page.locator('.gdh-similar-token__row').count();
  assert.equal(await count(), 2);
  await page.evaluate(() => { peerEl.remove(); requests=[]; scanSimilarTokenPanel(); });
  if (baseline) {
    assert.equal(await count(), 0);
    console.log('BASELINE v0.46.65: matched tracker row unmount makes the whole panel disappear');
  } else {
    assert.equal(await count(), 2);
    assert.equal(await page.locator('.gdh-similar-token__cached').count(), 1);
    assert.equal(await page.evaluate(() => requests.length), 0);
    pass('empty virtual list retains results, marks cached data and sends no extra request');
    await page.evaluate(() => { now+=4*60000;scanSimilarTokenPanel(); });
    assert.equal(await count(), 2);
    await page.evaluate(() => { now+=60001;scanSimilarTokenPanel(); });
    assert.equal(await count(), 0);
    pass('five-minute expiry is not extended by cached rendering');
    await page.evaluate(() => { seed();now+=4*60000;scanSimilarTokenPanel();peerEl.remove();now+=4*60000;scanSimilarTokenPanel(); });
    assert.equal(await count(), 2);
    await page.evaluate(() => { now+=60001;scanSimilarTokenPanel(); });
    assert.equal(await count(), 0);
    pass('real tracker reappearance renews retention');
    await page.evaluate(() => { seed();settings.similarTokenCacheMinutes=10;peerEl.remove();now+=6*60000;scanSimilarTokenPanel(); });
    assert.equal(await count(), 2);
    await page.evaluate(() => { settings.similarTokenCacheMinutes=1;scanSimilarTokenPanel(); });
    assert.equal(await count(), 0);
    pass('duration changes apply to existing cache without waiting for a refresh');
    await page.evaluate((peer) => { seed();peerEl.remove();history.pushState({},'','/robinhood/token/'+peer);scanSimilarTokenPanel(); }, peer);
    assert.equal(await count(), 2);
    assert.match(await page.locator('[aria-current=true]').innerText(), /ROBINHOOD/);
    pass('switching to a cached peer preserves the group and highlights the new current token');
    await page.evaluate((other) => { history.pushState({},'','/base/token/'+other);scanSimilarTokenPanel(); }, other);
    assert.equal(await count(), 0);
    await page.evaluate((current) => { history.pushState({},'','/base/token/'+current);scanSimilarTokenPanel(); }, current);
    assert.equal(await count(), 2);
    pass('unrelated routes never inherit a previous token group');
    await page.evaluate(() => { document.querySelector('#tracker').style.display='none';scanSimilarTokenPanel(); });
    assert.equal(await count(), 0);
    await page.evaluate(() => { document.querySelector('#tracker').style.display='';scanSimilarTokenPanel(); });
    assert.equal(await count(), 2);
    pass('hidden tracker hides the panel and reopening restores unexpired results');
    await page.evaluate((peer) => { blocked.add('robinhood|'+peer);scanSimilarTokenPanel(); }, peer);
    assert.equal(await count(), 0);
    pass('blocking a cached peer removes it immediately');
    await page.evaluate(() => { seed();peerEl.remove();settings.enableSimilarTokenPanel=false;scanSimilarTokenPanel();settings.enableSimilarTokenPanel=true;scanSimilarTokenPanel(); });
    assert.equal(await count(), 0);
    pass('disabling the feature clears retained results');
    await page.evaluate((peer) => { seed();peerEl.remove();put('robinhood',peer,'flybook','FLYBOOK',300000,'GOOGL');scanSimilarTokenPanel(); }, peer);
    assert.match(await page.locator('.gdh-similar-token__row').first().innerText(), /\$300K/);
    assert.match(await page.locator('[aria-current=true]').innerText(), /BASE/);
    assert.match(await page.locator('.gdh-similar-token__cached').getAttribute('title'), /市值可能滞后/);
    pass('latest available metadata still updates sorting while cache is clearly labeled');
    const writes=await page.evaluate(async()=>{let n=0;const ob=new MutationObserver(m=>{n+=m.length;});ob.observe(similarTokenPanelEl,{subtree:true,attributes:true,childList:true});now+=1000;scanSimilarTokenPanel();await Promise.resolve();ob.disconnect();return n;});
    assert.equal(writes,0);
    pass('stable cache scans do not rewrite DOM');
    await page.evaluate(() => { similarTokenMetaCache.clear();scanSimilarTokenPanel(); });
    assert.equal(await count(), 2);
    pass('quote-cache eviction does not discard retained display data');
  }
} finally { await browser.close(); }
