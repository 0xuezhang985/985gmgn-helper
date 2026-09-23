import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const adapter = read('../tracking-recycler.js');
const content = read('../content.js');
const audit = read('./verify-audit-fixes.mjs');
const take = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
const observerStart = content.indexOf('const observer = new MutationObserver((records) => {', content.indexOf('const GDH_SELF_SELECTOR'));
const observerSource = content.slice(observerStart, content.indexOf('  observer.observe(document.documentElement', observerStart));

// Bundle the locally installed React test runtime; no CDN/network dependency.
const modules = [], ids = new Map();
function bundle(file) {
  if (ids.has(file)) return ids.get(file);
  const id = modules.length; ids.set(file, id); modules.push('');
  const local = createRequire(file);
  const source = fs.readFileSync(file, 'utf8').replaceAll('process.env.NODE_ENV', '"production"')
    .replace(/require\((['"])([^'"]+)\1\)/g, (_, quote, name) => `load(${bundle(local.resolve(name))})`);
  modules[id] = `function(module,exports,load){${source}\n}`;
  return id;
}
const react = bundle(require.resolve('react'));
const reactDOM = bundle(require.resolve('react-dom/client'));
const runtime = `(()=>{const modules=[${modules.join(',')}],cache={};function load(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,load);return m.exports;}window.React=load(${react});window.ReactDOM=load(${reactDOM});})();`;

let passes = 0;
const pass = message => console.log(`PASS ${++passes}: ${message}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<style>*{box-sizing:border-box}body{margin:0;background:#111;color:white}#app{width:420px;height:1100px}[data-gdh-token-blocked="1"]{visibility:hidden}.native{height:100%;border-bottom:1px solid #333}.gdh-fomofeed{height:100%;background:#13251a}</style><div id="app" data-sentry-component="TrackingBody"></div>');
  await page.addScriptTag({ content: runtime });
  await page.addScriptTag({ content: `
    const R=React, h=R.createElement;
    const blockedAddress='0x'+'a'.repeat(40);
    const now=1800000000000;
    window.data=Array.from({length:100},(_,i)=>Object.freeze({
      id:'native-'+i,chain:'bsc',base_address:i<20&&i%2===0||i>=30&&i<35?blockedAddress:'0x'+String(i+100).padStart(40,'0'),
      token_address:blockedAddress, maker:'maker-'+i, side:'buy',timestamp:(now-i*1000)/1000,transaction_hash:'tx-'+i,amount_usd:100,
    }));
    Object.freeze(data);
    const Slot=R.memo(({slot,renderItem,itemHeight})=>h('div',{
      style:{position:'absolute',top:0,left:0,width:'100%',height:itemHeight,contain:'layout style paint',transform:'translateY('+slot.index*itemHeight+'px)'}
    },renderItem(slot.row,slot.index)));
    // Same native contract: fixed-height rows, bounded window, physical slot reuse.
    window.Recycler=R.forwardRef(function({data,itemHeight,overscan=2,renderItem,itemKey},ref){
      const scroller=R.useRef(null),[height,setHeight]=R.useState(1100),top=R.useRef(0),[,update]=R.useState(0),frame=R.useRef(0);
      R.useEffect(()=>{const el=scroller.current;const ro=new ResizeObserver(es=>setHeight(es[0].contentRect.height));ro.observe(el);return()=>ro.disconnect()},[]);
      const onScroll=R.useCallback(e=>{top.current=e.target.scrollTop;if(!frame.current)frame.current=requestAnimationFrame(()=>{frame.current=0;update(x=>x+1)})},[]);
      const poolSize=Math.ceil(height/itemHeight)+2*overscan,total=data.length*itemHeight;
      const clamped=Math.min(top.current,Math.max(0,total-height));
      const count=Math.min(poolSize,data.length),start=Math.max(0,Math.min(Math.max(0,Math.floor(clamped/itemHeight)-overscan),data.length-count));
      const previous=R.useRef(new Map());
      const slots=R.useMemo(()=>{
        const used=new Set(),pending=[],result=[],next=new Map();
        for(let index=start;index<start+count;index++){
          const row=data[index],key=itemKey(row,index),slot=previous.current.get(key);
          if(slot!==undefined&&slot<poolSize&&!used.has(slot)){used.add(slot);next.set(key,slot);result.push({row,index,slot})}else pending.push({row,index,key});
        }
        for(const entry of pending){let slot=0;while(used.has(slot))slot++;used.add(slot);next.set(entry.key,slot);result.push({...entry,slot})}
        previous.current=next;return result.sort((a,b)=>a.slot-b.slot);
      },[data,start,count,poolSize,itemKey]);
      if(!data.length)return h('div',{ref:scroller,className:'g-table-recycler-scroll',style:{height:'100%'}},'No data');
      return h('div',{ref:scroller,className:'g-table-recycler-scroll',onScroll,style:{height:'100%',overflowY:'auto',position:'relative'}},
        h('div',{className:'spacer',style:{height:total,position:'relative'}},slots.map(slot=>h(Slot,{key:slot.slot,slot,renderItem,itemHeight}))));
    });
    window.itemCalls=0;
    window.nativeItem=(row,index)=>{itemCalls++;return h('a',{className:'native','data-sentry-component':'TrackerListItem','data-id':row.id,'data-token':row.base_address,style:{display:'block'},href:'#'+row.id},row.id)};
    window.itemHeight=64.5;window.component='TrackerList';
    window.root=ReactDOM.createRoot(document.querySelector('#app'));
    window.render=()=>root.render(h(Recycler,{'data-sentry-component':component,data,itemHeight,renderItem:nativeItem,itemKey:row=>row.id}));
    render();
  ` });
  const settle = async () => { for (let i = 0; i < 5; i++) await page.evaluate(() => new Promise(requestAnimationFrame)); };
  await settle();
  const geometry = () => page.evaluate(() => {
    const scroller=document.querySelector('.g-table-recycler-scroll'),viewport=scroller.getBoundingClientRect();
    const rows=[...document.querySelectorAll('.native,.gdh-fomofeed')].filter(el=>getComputedStyle(el).visibility!=='hidden')
      .map(el=>{const r=el.getBoundingClientRect();return {top:r.top-viewport.top,bottom:r.bottom-viewport.top,id:el.dataset.id||el.textContent}})
      .filter(r=>r.bottom>0&&r.top<viewport.height).sort((a,b)=>a.top-b.top);
    let edge=0,gap=0;for(const row of rows){gap=Math.max(gap,row.top-edge);edge=Math.max(edge,row.bottom)}
    gap=Math.max(gap,Math.min(viewport.height,scroller.scrollHeight-scroller.scrollTop)-edge);
    return {gap,rows:rows.length,slots:document.querySelector('.spacer').children.length,height:parseFloat(document.querySelector('.spacer').style.height),top:scroller.scrollTop};
  });
  // Execute the old real DOM-collapse implementation against the React fixture.
  await page.addScriptTag({ content: `
    const fomoFeedCards=new Map(),fomoFeedShifted=new Set();
    const trackerCards=()=>[...document.querySelectorAll('.native')];
    ${['fomoFeedInsertionShift','fomoFeedNativeTransformY','fomoFeedFixedRow','refreshFomoFeedFixedRowShifts','clearFomoFeedShifts','layoutFomoFeedFixed'].map(name=>take(content,name)).join('\n')}
    for(const row of trackerCards())if(row.dataset.token===blockedAddress)row.dataset.gdhTokenBlocked='1';
    layoutFomoFeedFixed(trackerCards(),new Map());
  ` });
  const before = await geometry();
  assert.ok(before.gap > 250, JSON.stringify(before));
  pass(`old collapse reproduces ${before.gap}px blank viewport with available later records`);
  await page.addScriptTag({ content: adapter });
  await page.evaluate(() => {
    window.adapter=GdhTrackingRecycler.create();
    window.config={blocked:['bsc|'+blockedAddress],feeds:[]};
    adapter.setConfig(config);adapter.scan();
    clearFomoFeedShifts();document.querySelectorAll('[data-gdh-token-blocked]').forEach(el=>el.removeAttribute('data-gdh-token-blocked'));
  });
  await settle();
  const after = await geometry();
  assert.ok(after.gap < 1, JSON.stringify(after));
  assert.equal(after.height,85*64.5);
  assert.equal(await page.locator(`.native[data-token="0x${'a'.repeat(40)}"]`).count(),0);
  pass(`filter-before-window fills viewport; ${before.rows} -> ${after.rows} visible rows, no hidden slots`);
  assert.equal(await page.evaluate(()=>adapter.project(data)===adapter.project(data)),true);
  assert.equal(await page.evaluate(()=>data.length),100);
  pass('original frozen data is unchanged and projection is memoized');

  // Use the actual content-side slot mounting function, not a replacement renderer.
  await page.addScriptTag({content:`
    let nativeTrackerFeeds=new Map();const nativeTrackerFeedCards=new Map();let nativeTrackerFeedRaf=0;
    window.feedUpdates=0;
    function fomoFeedCardFor(ev,cache=fomoFeedCards){feedUpdates++;let card=cache.get(ev.key);if(!card){card=document.createElement('div');card.className='gdh-fomofeed';card.textContent=ev.key;card.onclick=()=>window.clicked=ev.key;cache.set(ev.key,card)}return card}
    ${take(content,'prepareNativeTrackerFeedComment')}
    ${take(content,'mountNativeTrackerFeeds')}
    ${take(content,'scheduleNativeTrackerFeeds')}
    ${content.includes('function scheduleNativeTrackerFeedMutations(')?take(content,'scheduleNativeTrackerFeedMutations'):''}
    const GDH_SELF_SELECTOR='[data-gdh-fomo-key]',similarTokenPanelEl=null;
    const scheduleScan=()=>{},scheduleSimilarTokenScan=()=>{},scheduleSimilarTokenPosition=()=>{},scheduleFomoFeedRowReflow=()=>{};
    const settings={};
    ${observerSource}
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-gdh-native-feed-key']});
    window.setFeeds=feeds=>{nativeTrackerFeeds=new Map(feeds.map(row=>[row.key,row]));config={...config,feeds};adapter.setConfig(config);adapter.scan();mountNativeTrackerFeeds()};
    setFeeds(Array.from({length:30},(_,i)=>({key:'feed-'+i,ts:now-i*2700+500,source:i%2?'pump':'fomo',type:'buy',tx:'feed-tx-'+i})));
  `});
  await settle();
  assert.equal((await geometry()).height,115*64.5);
  assert.ok((await geometry()).gap < 1);
  await page.locator('.gdh-fomofeed').first().click();
  assert.ok(await page.evaluate(()=>window.clicked?.startsWith('feed-')));
  pass('FOMO/Pump share native slots and scroll height; card clicks remain attached');
  await page.evaluate(()=>{window.outside=document.createElement('div');document.body.append(outside)});
  await settle();
  const previousKey=await page.evaluate(()=>{
    const slot=document.querySelector('[data-gdh-native-feed-key]'),previous=slot.dataset.gdhNativeFeedKey;
    outside.textContent='unrelated page mutation first';slot.dataset.gdhNativeFeedKey='feed-20';
    return previous;
  });
  await settle();
  assert.equal(await page.locator('[data-gdh-native-feed-key="feed-20"]').first().textContent(),'feed-20','earlier unrelated mutation must not drop the later recycled-feed update');
  await page.evaluate(key=>{document.querySelector('[data-gdh-native-feed-key="feed-20"]').dataset.gdhNativeFeedKey=key;outside.remove()},previousKey);
  await settle();
  pass('production observer handles recycled-feed updates after unrelated mutations in the same batch');
  assert.equal(await page.evaluate(()=>{feedUpdates=0;for(let i=0;i<10;i++)mountNativeTrackerFeeds();return feedUpdates}),0);
  assert.ok(await page.evaluate(()=>{mountNativeTrackerFeeds(true);return feedUpdates>0}));
  pass('scroll fast path skips unchanged cards; full scans still refresh settings and relative time');
  await page.evaluate(()=>{itemCalls=0;document.querySelector('.g-table-recycler-scroll').dispatchEvent(new Event('scroll'))});
  await settle();
  assert.equal(await page.evaluate(()=>itemCalls),0);
  pass('unchanged scroll offset preserves native memoized row rendering');
  for (const rowHeight of [64.5,44,45]) {
    await page.evaluate(height=>{itemHeight=height;component=height===64.5?'TrackerList':undefined;render()},rowHeight);
    await settle();
    await page.evaluate(()=>adapter.scan());
    await settle();
    for(let step=0;step<28;step++) {
      await page.evaluate(step=>{const el=document.querySelector('.g-table-recycler-scroll');const fraction=step<14?step/13:(27-step)/13;el.scrollTop=fraction*(el.scrollHeight-el.clientHeight);el.dispatchEvent(new Event('scroll'))},step);
      await settle();
      const state=await geometry();
      assert.ok(state.gap<1,JSON.stringify({rowHeight,step,...state}));
      assert.ok(state.slots<=Math.ceil(1100/rowHeight)+4,JSON.stringify(state));
      assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-gdh-native-feed-key]')].every(slot=>slot.textContent===slot.dataset.gdhNativeFeedKey)),true,'recycled feed slots must contain the new event, not the previous card');
    }
    pass(`${rowHeight}px layout: down/up/end-of-list stays filled with bounded recycled slots`);
  }
  await page.evaluate(()=>{data=Object.freeze([Object.freeze({...data[1],id:'new-push',timestamp:(now+5000)/1000}),...data]);render()});
  await settle();
  assert.ok((await geometry()).gap<1);
  assert.equal((await geometry()).height,116*45);
  pass('new native push updates combined count without manual translations');
  await page.evaluate(()=>{config={blocked:[],feeds:[]};nativeTrackerFeeds.clear();adapter.setConfig(config);adapter.scan()});
  await settle();
  assert.equal((await geometry()).height,101*45);
  assert.equal(await page.locator('[data-gdh-native-feed-key]').count(),0);
  pass('disabling feeds/unblocking restores the full original list');

  await page.evaluate(()=>{config={blocked:data.map(row=>row.chain+'|'+row.base_address.toLowerCase()),feeds:[]};adapter.setConfig(config);adapter.scan()});
  await settle();
  assert.equal((await geometry()).height,45);
  assert.equal(await page.locator('.gdh-native-tracker-empty').count(),1);
  await page.evaluate(()=>setFeeds([{key:'only-feed',ts:now,type:'buy',source:'fomo'}]));
  await settle();
  assert.equal((await geometry()).height,45);
  assert.equal(await page.locator('.gdh-fomofeed').count(),1);
  pass('all native records blocked still allows an actual feed-only list');
  await page.evaluate(()=>{component='OtherPanel';render()});
  await settle();
  await page.evaluate(()=>adapter.scan());
  assert.equal((await geometry()).height,101*45);
  assert.equal(await page.locator('[data-gdh-native-recycler]').count(),0);
  pass('shared Recycler used by another panel is not filtered or marked as tracking');

  await page.evaluate(()=>{
    component='TrackerList';render();
    window.secondPanel=document.createElement('section');secondPanel.setAttribute('data-sentry-component','TrackingBody');secondPanel.style.height='600px';document.body.append(secondPanel);
    window.secondRoot=ReactDOM.createRoot(secondPanel);
    secondRoot.render(h(Recycler,{'data-sentry-component':'TrackerList',data,itemHeight,renderItem:nativeItem,itemKey:row=>row.id}));
  });
  await settle();await page.evaluate(()=>adapter.scan());await settle();await page.evaluate(()=>mountNativeTrackerFeeds());
  assert.equal(await page.locator('[data-gdh-native-feed-key="only-feed"] .gdh-fomofeed').count(),2);
  assert.equal(await page.evaluate(()=>{const cards=[...document.querySelectorAll('.gdh-fomofeed')];return cards.length===2&&cards[0]!==cards[1]}),true);
  const noRefresh=await page.evaluate(()=>{let count=0;const fn=()=>count++;document.addEventListener('scroll',fn,true);for(let i=0;i<5;i++)adapter.scan();document.removeEventListener('scroll',fn,true);return count});
  assert.equal(noRefresh,0);
  await page.evaluate(()=>{secondRoot.unmount();secondPanel.remove();mountNativeTrackerFeeds()});
  pass('two tracking panels own independent cards; stable scans do not dispatch refresh events');

  const unit=vm.createContext({});vm.runInContext(adapter,unit);const api=unit.GdhTrackingRecycler.create();
  const base={chain:'bsc',base_address:'0xABC',token_address:'wrong',side:'buy',timestamp:1800000000,maker:'0xDEF',amount_usd:100};
  const mixed=[base,{...base,chain:'eth'},{...base,chain:'sol',base_address:'Case'},{...base,chain:'sol',base_address:'case'}];
  api.setConfig({blocked:['bsc|0xabc','sol|Case'],feeds:[]});
  assert.deepEqual(Array.from(api.project(mixed),r=>r.base_address),['0xABC','case']);
  api.setConfig({blocked:[],feeds:[{key:'dup',ts:1800000000000,type:'buy',source:'pump',chain:'bsc',addr:'0xabc',pumpWallet:'0xdef',usd:100}]});
  assert.equal(api.project([base]).length,1);
  api.setConfig({blocked:[],feeds:[{key:'other',ts:1800000000000,type:'buy',source:'fomo',chain:'bsc',addr:'0xabc',usd:100}]});
  assert.equal(api.project([base]).length,2);
  const solRecord={...base,chain:'sol',transaction_hash:'SolanaTxCase'};
  const solFeed={key:'sol-case',ts:1800000000000,type:'buy',source:'fomo',chain:'sol',tx:'solanatxcase'};
  api.setConfig({blocked:[],feeds:[solFeed]});
  assert.equal(api.project([solRecord]).length,2,'Solana transaction hashes are case sensitive');
  api.setConfig({blocked:[],feeds:[{...solFeed,tx:solRecord.transaction_hash}]});
  assert.equal(api.project([solRecord]).length,1);
  pass('chain-specific blocks, EVM/Solana casing, base-token identity and strict duplicate rules');
  assert.deepEqual(errors,[]);
  pass('no React/page errors');
  console.log(JSON.stringify({before,after}));
} finally { await browser.close(); }
