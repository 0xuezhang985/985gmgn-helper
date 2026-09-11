// Offline browser test; no GMGN account or API requests. PLAYWRIGHT_MODULE may point to a local install.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const content = read('content.js');
const bridge = read('page-bridge.js');
const take = (name) => { let start = content.indexOf(`function ${name}(`); if (content.slice(start-6,start)==='async ') start-=6; return content.slice(start, content.indexOf('\n  }', start) + 4); };
const current = '0x1111111111111111111111111111111111111111';
const peer = '0x2222222222222222222222222222222222222222';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html data-theme="dark"><style>:root{--color-bg-100:18 18 18;--color-text-100:240 240 240;--color-line-100:40 40 40}body{background:#111;color:white}
    #tracker{position:fixed;left:400px;top:50px;width:350px;height:500px}.row{display:block;height:44px}</style>
    <section id="tracker"><button data-testid="follow-tracking-tab">追踪</button><div id="tracking-body">
    <a class="row" href="/robinhood/token/${peer}">FLYBOOK</a></div></section></html>` }));
  await page.goto(`https://gmgn.ai/base/token/${current}`);
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    const settings={enableSimilarTokenPanel:true};
    const TRACK_TAB_CELL='[data-testid="follow-tracking-tab"]';
    const trackerCards=()=>[...document.querySelectorAll('#tracker .row')];
    const currentTokenRoute=()=>{const m=location.pathname.match(/^\\/(\\w+)\\/token\\/(\\w+)/);return m?{chain:m[1],address:m[2]}:null;};
    const gmgnApiQuery=()=>''; const scheduleScan=()=>{};
    window.isTokenBlocked=()=>false;
    ${take('trackingFeedNormalizedAddress')}
    ${take('setBoundedMap')}
    ${take('gdhSpaNavigate')}
    ${content.slice(content.indexOf('  const SIMILAR_TOKEN_META_TTL'), content.indexOf('  function requestStonkfunRwaCatalog'))}
    const put=(chain,address,name,symbol,marketCap,poolSymbol)=>similarTokenMetaCache.set(similarTokenMetaKey(chain,address),{at:Date.now(),data:{chain,address,name,symbol,marketCap,poolSymbol}});
    put('base','${current}','The Flybook','FLYBOOK',200000,'WETH');
    put('robinhood','${peer}','flybook','FLYBOOK',130000,'GOOGL');
    window.next={router:{push:async(url)=>{await new Promise(r=>setTimeout(r,700));history.pushState({},'',url);}}};
    ${bridge.slice(bridge.indexOf('  const GDH_NAV_RE'), bridge.indexOf('  let nativeBlacklistApi'))}
    ${bridge.slice(bridge.lastIndexOf("  document.addEventListener('gdh-navigate'"), bridge.lastIndexOf('})();'))}
    scanSimilarTokenPanel();
  ` });
  const state = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.gdh-similar-token__row')].map((r) => ({ text: r.textContent, current: r.getAttribute('aria-current') })), bg: getComputedStyle(document.querySelector('.gdh-similar-token-panel')).backgroundColor, timeOrigin: performance.timeOrigin }));
  assert.equal(state.rows.length, 2, 'same ticker with different name must match, even when current is absent from tracker');
  assert.ok(state.rows[0].text.includes('$200K') && state.rows[0].text.includes('当前币'));
  assert.equal(state.rows[0].current, 'true');
  assert.ok(state.rows[1].text.includes('GOOGL'));
  assert.notEqual(state.bg, 'rgba(0, 0, 0, 0)', 'GMGN RGB-channel theme variables must resolve');
  const writes = await page.evaluate(async () => { let count=0;const o=new MutationObserver(m=>{count+=m.length;});o.observe(similarTokenPanelEl,{subtree:true,attributes:true,childList:true});scanSimilarTokenPanel();scanSimilarTokenPanel();await Promise.resolve();o.disconnect();return count; });
  assert.equal(writes, 0);
  await page.evaluate(() => { document.documentElement.dataset.theme='light';document.documentElement.style.setProperty('--color-bg-100','255 255 255');document.documentElement.style.setProperty('--color-text-100','25 25 25'); });
  assert.equal(await page.locator('.is-current .gdh-similar-token__identity > strong').evaluate(e=>getComputedStyle(e).color), 'rgb(8, 122, 73)');
  await page.locator('.gdh-similar-token__row').nth(1).click();
  await page.waitForURL(`**/robinhood/token/${peer}`);
  assert.equal(await page.evaluate(() => performance.timeOrigin), state.timeOrigin, 'slow route must not reload');
  await page.evaluate(({current})=>{const a=document.createElement('a');a.className='row';a.href='/base/token/'+current;a.textContent='FLYBOOK';document.querySelector('#tracking-body').appendChild(a);scanSimilarTokenPanel();},{current});
  assert.ok((await page.locator('.gdh-similar-token__row[aria-current=true]').innerText()).includes('ROBINHOOD'));
  await page.evaluate(()=>{settings.enableSimilarTokenPanel=false;scanSimilarTokenPanel();});
  assert.equal(await page.locator('.gdh-similar-token-panel').count(),0);
  console.log('PASS similar-token browser checks: matching/current inclusion/order/highlight/pool/theme/idempotence/slow SPA/current switch/disable');
  await page.addScriptTag({content:`
    settings.syncGmgnTokenBlacklist=true; settings.blockedTokens=[];
    let blockedTokenSet=new Set(); const nativeTokenBlockPending=new Set();
    const TRACKER_SYMBOL_CELL='.symbol'; const findTrackerSymbolNode=()=>null;
    const findCardActionContainer=(card)=>card; const scanSpecialWallets=()=>{};
    const showTrackToast=(text)=>{window.lastToast=text;};
    window.chrome={storage:{local:{set:(value,callback)=>callback()}},runtime:{}};
    window.nativeRequests=[];
    document.addEventListener('gdh-native-token-blacklist',()=>{
      const root=document.documentElement;
      const r=JSON.parse(root.getAttribute('data-gdh-native-blacklist-request'));
      root.removeAttribute('data-gdh-native-blacklist-request'); nativeRequests.push(r);
      const reply=()=>{
        root.setAttribute('data-gdh-native-blacklist-result',JSON.stringify({id:r.id,...(window.nativeReplyResult||{ok:true})}));
        document.dispatchEvent(new Event('gdh-native-token-blacklist-result'));
      };
      if(window.nativeReplyDelay) setTimeout(reply,window.nativeReplyDelay); else reply();
    });
    ${['requestNativeTokenBlacklist','getBlockedTokens','rebuildBlockedTokenIndex','isTokenBlocked','persistBlockedTokens','toggleBlockedToken','ensureTokenBlockButton','renderBlockedTokenList'].map(take).join('\n')}
    window.blockCard=document.querySelector('#tracker .row');
    ensureTokenBlockButton(blockCard,'${peer}','FLYBOOK');
  `});
  await page.locator('.gdh-tokenblock').click({force:true});
  assert.equal(await page.evaluate(()=>nativeRequests.length),0,'short click must not block');
  await page.locator('.gdh-tokenblock').dispatchEvent('pointerdown',{button:0});
  await page.waitForFunction(()=>nativeRequests.length===1);
  assert.deepEqual(await page.evaluate(()=>nativeRequests.map(x=>[x.action,x.chain])),[['add','robinhood']]);
  assert.equal(await page.evaluate(()=>settings.blockedTokens[0].nativeSynced),true);
  await page.locator('.gdh-tokenblock').dispatchEvent('pointerup',{button:0});
  await page.locator('.gdh-tokenblock').click({force:true});
  assert.equal(await page.evaluate(()=>nativeRequests.length),1,'tail click must not undo');
  await page.waitForFunction(()=>Date.now()-Number(document.querySelector('.gdh-tokenblock').dataset.gdhTbFiredAt)>550);
  await page.locator('.gdh-tokenblock').click({force:true});
  assert.equal(await page.evaluate(()=>settings.blockedTokens.length),0);
  assert.deepEqual(await page.evaluate(()=>nativeRequests.map(x=>x.action)),['add','remove']);
  await page.locator('.gdh-tokenblock').dispatchEvent('pointerdown',{button:0});
  await page.evaluate(()=>{blockCard.setAttribute('href','/bsc/token/0x3333333333333333333333333333333333333333');});
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(()=>nativeRequests.length),2,'recycled card must cancel held action');
  await page.evaluate(()=>{settings.enableSimilarTokenPanel=true;scanSimilarTokenPanel();});
  const beforeHold = page.url();
  await page.locator('.gdh-similar-token__row').first().dispatchEvent('pointerdown',{button:0});
  await page.waitForFunction(()=>nativeRequests.length===3);
  await page.locator('.gdh-similar-token__row').first().dispatchEvent('pointerup',{button:0});
  await page.locator('.gdh-similar-token__row').first().click({force:true});
  assert.equal(page.url(), beforeHold);
  assert.deepEqual(await page.evaluate(()=>[nativeRequests[2].action,nativeRequests[2].chain]),['add','base']);
  await page.evaluate(()=>{
    window.nativeReplyDelay=300;
    window.manage=document.createElement('div');manage.innerHTML='<div class="gdh-sp-manage__blocked"></div>';
    document.body.appendChild(manage);renderBlockedTokenList(manage);
  });
  await page.locator('.gdh-sp-manage__undo').click();
  assert.equal(await page.locator('.gdh-sp-manage__undo').isDisabled(),true,'restore must await native acknowledgement');
  await page.waitForFunction(()=>settings.blockedTokens.length===0);
  assert.equal(await page.locator('.gdh-sp-manage__undo').count(),0,'restore list must repaint after acknowledgement');
  await page.evaluate(async({current})=>{
    window.nativeReplyDelay=0;window.nativeReplyResult={ok:false,reason:'native-unavailable'};
    await toggleBlockedToken(current,'FLYBOOK','base');
  },{current});
  assert.equal(await page.evaluate(()=>settings.blockedTokens.length),0,'native failure must not pretend local success');
  assert.match(await page.evaluate(()=>lastToast),/未保存成功/);
  const beforeLocalOnly=await page.evaluate(()=>nativeRequests.length);
  await page.evaluate(async({current})=>{settings.syncGmgnTokenBlacklist=false;await toggleBlockedToken(current,'FLYBOOK','bsc');},{current});
  assert.equal(await page.evaluate(()=>nativeRequests.length),beforeLocalOnly,'disabled sync must remain local only');
  assert.equal(await page.evaluate(()=>settings.blockedTokens[0].nativeSynced),undefined);
  console.log('PASS blacklist browser checks: short click/long hold/native chain/tail click/restore/card recycling/float hold/async manager/failure/local-only (mock native store only)');
} finally { await browser.close(); }
