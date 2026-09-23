// Native watchlist flex structure and real production feed builders; offline only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.env.BGM_TEST_SOURCE || new URL('../', import.meta.url);
const read = name => fs.readFileSync(typeof root === 'string' ? path.join(root, name) : new URL(name, root), 'utf8');
const source = read('content.js'), css = read('styles.css');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const take = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [], errors = [];
let checks = 0;
function check(value, label) { checks++; if (!value) failures.push(label); console.log(`${value ? 'PASS' : 'FAIL'}: ${label}`); }
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:8px;background:#111;color:#ddd;font:13px Arial}
    #favorites{width:600px}.native-row{display:flex;width:100%;height:44px;border-bottom:1px solid #333}
    .cell{flex:1;min-width:0}.coin{flex:3;min-width:0;display:flex;align-items:center;padding:0 12px;gap:8px}
    .flex-col{display:flex;flex-direction:column;min-width:0}.name{display:flex;align-items:center;gap:4px;height:16px}
    .name p{margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .slot{height:64.5px;overflow:hidden;width:340px}.sentinel{height:64.5px}
    </style><div id="favorites" data-sentry-component="WatchList"></div><div id="feeds"></div>`);
  await page.addStyleTag({ content: css });
  const funcs = ['markedHoldingSummary', 'holdingShareText', 'ensureMarkedBadge', 'watchlistMarkedBadgeHost', 'scanMarkedBadges',
    'buildFomoFeedCard', 'buildFomoFeedTableRow', 'attachFomoFeedCardBehavior', 'paintTranslation',
    'prepareNativeTrackerFeedComment', 'showNativeTrackerFeedDetails', 'mountNativeTrackerFeeds'];
  await page.addScriptTag({ content: `
    const settings={enableMarkedHolders:true},markedMap=new Map(),loadMarkedHoldings=()=>{},trackerCards=()=>[],tokenHeaderBlock=()=>null;
    const TRACKER_ITEM_SELECTOR='.native-tracker',TRACKER_SYMBOL_CELL='.symbol-cell',TRACKER_MAKER_CELL='.maker-cell';
    const fomoUsd=v=>'$'+v, fomoFeedRelTime=()=> '1m', fomoFeedChainColor=()=> '#0c9';
    const trackingFeedProfileMeta=()=>({title:'Fixture profile',source:'FOMO',url:''}),attachFeedSoundButton=()=>{},attachFomoFeedRank=()=>{};
    const FOMO_FEED_TAGS={thesis:{label:'观点',cls:'is-thesis'},refund:{label:'失败',cls:'is-refund'},buy:{label:'买入',cls:'is-buy'}};
    const fomoFeedSeen=new Set(),FOMO_FEED_SEEN_MAX=100,rememberBoundedSet=(set,key)=>set.add(key),announceFeedEvent=()=>{};
    window.navigated='';const gdhSpaNavigate=url=>{window.navigated=url};
    window.table=false;const isTrackerTableMode=()=>window.table;
    const queueFomoTranslate=(el,text)=>setTimeout(()=>paintTranslation(el,'完整译文：'+text),25);
    let nativeTrackerFeeds=new Map(),nativeTrackerFeedRaf=0,nativeTrackerFeedDetails=null;
    const nativeTrackerFeedCards=new Map(),fomoFeedCards=new Map();
    const fomoFeedCardFor=(ev,cache)=>{let c=cache.get(ev.key);if(!c){c=buildFomoFeedCard(ev);cache.set(ev.key,c)}return c};
    ${funcs.filter(n=>source.includes('function '+n+'(')).map(n=>take(source,n)).join('\n')}
    for(let i=1;i<=3;i++){
      const token='0x'+String(i).repeat(40),a=document.createElement('a');a.href='/bsc/token/'+token;
      a.style.cssText='display:flex;width:100%;height:44px';
      a.innerHTML='<div class="native-row"><div class="coin"><span style="flex:none;width:26px">●</span><div class="flex-col"><div class="name"><p>Token '+i+'</p><div data-sentry-component="TokenWatch">★</div></div></div></div><div class="cell">$4.4M</div><div class="cell">$803K</div><div class="cell">+492%</div></div>';
      document.querySelector('#favorites').append(a);
      if(i!==2)markedMap.set(token,[{name:'Example holder '+i,amount:263,supply:10000,usd:500}]);
    }
    window.columns=()=>[...document.querySelectorAll('.native-row')].map(row=>[...row.children].slice(1).map(e=>e.getBoundingClientRect().left));
    window.makeFeed=(mode,type='thesis')=>{
      window.table=mode;document.querySelector('#feeds').replaceChildren();nativeTrackerFeedCards.clear();
      const panel=document.createElement('div');panel.dataset.gdhNativeRecycler='1';
      const slot=document.createElement('div');slot.className='slot';slot.style.height=mode?'45px':'64.5px';slot.dataset.gdhNativeFeedKey='post';
      const below=document.createElement('div');below.className='sentinel';below.textContent='Next native trade';
      panel.append(slot,below);document.querySelector('#feeds').append(panel);
      const ev={key:'post',type,name:'Author',handle:'writer',symbol:'TOKEN',addr:'0x'+'1'.repeat(40),chain:'bsc',source:'fomo',mc:3600000,usd:0,ts:Date.now(),comment:'A long opinion with <b>literal text</b> and many words. '.repeat(30)};
      nativeTrackerFeeds=new Map([['post',ev]]);mountNativeTrackerFeeds(true);return ev.comment;
    };
  ` });
  for (const width of [600, 360, 900]) {
    await page.evaluate(width=>{document.querySelector('#favorites').style.width=width+'px';scanMarkedBadges()},width);
    const aligned = await page.evaluate(()=>columns().every(row=>row.every((x,i)=>Math.abs(x-columns()[1][i])<0.1)));
    check(aligned, `mixed watchlist numeric columns align at ${width}px`);
  }
  check(await page.locator('.gdh-marked--watchlist').count()===2, 'badges are inside the coin cell, not extra flex columns');
  check(await page.evaluate(async()=>{
    let n=0;const o=new MutationObserver(ms=>n+=ms.length);o.observe(document.querySelector('#favorites'),{subtree:true,attributes:true,childList:true,characterData:true});
    scanMarkedBadges();scanMarkedBadges();await Promise.resolve();o.disconnect();return n===0;
  }), 'unchanged badge scans perform no DOM writes');
  await page.evaluate(()=>{markedMap.delete('0x'+'1'.repeat(40));scanMarkedBadges()});
  check(await page.locator('.gdh-marked').count()===1,'holding removal removes only its badge');
  await page.evaluate(()=>{settings.enableMarkedHolders=false;scanMarkedBadges()});
  check(await page.locator('.gdh-marked').count()===0,'switching marked holdings off cleans badges');
  if(source.includes('function showNativeTrackerFeedDetails(')) {
    await page.evaluate(()=>{
      const anchor=document.createElement('button');anchor.id='low-anchor';anchor.textContent='Post';
      anchor.style.cssText='position:fixed;bottom:10px;right:10px';document.body.append(anchor);
      showNativeTrackerFeedDetails(anchor,{name:'Author',symbol:'TOKEN',comment:'Short original'});
      // Translation can arrive later and be much longer than the original.
      paintTranslation(document.querySelector('.gdh-fomofeed-details__body > div'),'Late translated text. '.repeat(300));
    });
    check(await page.evaluate(()=>{const p=document.querySelector('.gdh-fomofeed-details'),r=p.getBoundingClientRect();return r.bottom<=innerHeight&&p.scrollHeight>p.clientHeight}), 'late long translation stays on screen and scrolls inside details');
    await page.locator('.gdh-fomofeed-details button').click();
    await page.evaluate(()=>document.querySelector('#low-anchor').remove());
  }
  for (const table of [false,true]) for (const type of ['thesis','refund']) {
    const text=await page.evaluate(({table,type})=>makeFeed(table,type),{table,type});
    await page.waitForTimeout(50);
    const result=await page.evaluate(()=>{
      const c=document.querySelector('.gdh-fomofeed'),r=c.getBoundingClientRect(),head=c.querySelector('.gdh-fomofeed__r1,.gdh-fomofeed__trow').getBoundingClientRect();
      const p=c.querySelector('.gdh-fomofeed__preview')?.getBoundingClientRect();
      return {visible:head.top>=r.top&&head.bottom<=r.bottom&&p&&p.bottom<=r.bottom+0.1,neighbor:document.querySelector('.sentinel').getBoundingClientRect().top-r.bottom};
    });
    check(result.visible&&Math.abs(result.neighbor)<0.1,`${table?'table':'card'} ${type}: complete header and preview fit; next row does not overlap`);
    if(!result.visible)continue;
    await page.locator('.gdh-fomofeed__preview').click();
    await page.waitForTimeout(50);
    check(await page.locator('.gdh-fomofeed-details .gdh-fomofeed__thesis').textContent()===text&&await page.locator('.gdh-fomofeed-details .gdh-fomo__zh').textContent()==='完整译文：'+text, 'full original and async translation remain readable outside recycler');
    check(await page.evaluate(()=>navigated==='')&&await page.locator('.gdh-fomofeed-details b').count()===0,'opening details neither navigates nor interprets post HTML');
    check(await page.evaluate(()=>{const p=document.querySelector('.gdh-fomofeed-details'),r=p.getBoundingClientRect();return p.matches(':popover-open')&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}), 'details stay within viewport and use top layer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(30);
    check(await page.locator('.gdh-fomofeed-details').count()===0,'Escape dismisses and cleans detail panel');
    await page.locator('.gdh-fomofeed__preview').click();
    await page.locator('.gdh-fomofeed-details button').click();
    check(await page.locator('.gdh-fomofeed-details').count()===0,'close button removes detail panel');
    await page.locator('.gdh-fomofeed__sym,.gdh-fomofeed__symtext').first().click();
    check(await page.evaluate(()=>navigated.startsWith('/bsc/token/')),'token click still navigates without refresh');
    await page.evaluate(()=>{window.navigated='';mountNativeTrackerFeeds(true);mountNativeTrackerFeeds(true)});
    check(await page.locator('.gdh-fomofeed__preview').count()===1,'refreshing a card does not duplicate the detail control');
  }
  check(errors.length===0,'no page errors: '+errors.join('; '));
  assert.deepEqual(failures,[],JSON.stringify({failures,checks}));
  console.log(`PASS ${checks} checks`);
} finally { await browser.close(); }
