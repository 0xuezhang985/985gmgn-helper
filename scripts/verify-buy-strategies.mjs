import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const source=read('buy-strategies.js'), priority=read('priority-push.js');
const context={};vm.runInNewContext(source,context);const S=context.GdhBuyStrategies;
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),C='0x'+'3'.repeat(40),T='0x'+'4'.repeat(40);
const config={group:{enabled:true,windowSeconds:300,wallets:[{address:A,label:'甲'},{address:B,label:'乙'}]},amount:{enabled:true,minUsd:1000,wallets:[{address:A,label:'甲'}]}};
let time=1800000000000,checks=0;const pass=n=>console.log(`PASS ${++checks}: ${n}`);
const engine=(cfg=config)=>{const e=S.create(()=>time);e.configure(cfg);return e;};
const event=(wallet=A,over={})=>({wallet,token:T,chain:'bsc',side:'buy',ts:time,tx:'tx-'+wallet,usd:100,symbol:'测试币',href:`/bsc/token/${T}`,...over});
assert.equal(S.enabled(),false);assert.equal(S.enabled({group:{enabled:true,wallets:[]}}),false);
assert.throws(()=>S.parseWallets('张三'),/完整/);assert.equal(S.parseWallets(`${A} 甲\n${A} 乙`).length,1);
assert.equal(S.normalize({amount:{enabled:'true',wallets:[{address:A}],minUsd:1}}).amount.enabled,false);
pass('默认关闭、无效配置不启用、地址校验和同地址去重');
{
 const e=engine();assert.equal(e.ingest([event(A)]).length,0);assert.equal(e.ingest([event(A),event(A,{tx:'another'})]).length,0);
 assert.equal(e.ingest([event(B)]).length,1);assert.equal(e.ingest([event(B),event(A)]).length,0);
 assert.equal(e.ingest([event(A,{tx:'third'})]).length,0);assert.equal(e.ingest([event(B,{tx:'fourth'})]).length,1);
 pass('必须指定的每个人买入；同一人买多笔不凑人数；下一轮需每人再买');
}
{
 const e=engine();e.ingest([event()]);assert.equal(e.ingest([event(B,{chain:'eth'})]).length,0);
 assert.equal(e.ingest([event(B,{token:C})]).length,0);assert.equal(e.ingest([event(B,{side:'sell'})]).length,0);
 for(const side of ['transferIn','thesis','swap','refund'])assert.equal(e.ingest([event(A,{side,usd:99999})]).length,0);
 time+=301000;assert.equal(e.ingest([event(B)]).length,0);
 pass('链和合约地址隔离、卖出转入观点不触发、超过时间窗口不凑单');
}
{
 const e=engine();assert.equal(e.ingest([event(A,{usd:1000})]).length,0);
 assert.equal(e.ingest([event(A,{usd:undefined})]).length,0);
 const r=e.ingest([event(A,{usd:1000.01})]);assert.equal(r.length,1);assert.match(r[0].record.detail,/1,000.01/);
 assert.equal(e.ingest([event(A,{usd:3000})]).length,0);
 assert.equal(e.ingest([event(A,{tx:'distinct',usd:3000})]).length,1);
 assert.equal(e.ingest([event(C,{usd:3000})]).length,0);
 pass('严格大于单笔 USD 阈值、金额晚到补判、已提醒不重复、不同交易仍提醒');
}
{
 const e=engine();assert.equal(e.ingest([event(A,{ts:time-1000,usd:9999})]).length,0);
 assert.equal(e.ingest([event(A,{ts:time+100000,usd:9999})]).length,0);
 e.configure({});assert.equal(e.ingest([event(A,{usd:9999})]).length,0);
 pass('不补报开启前历史、不接受异常未来时间、关闭立即停止');
}
{
 const e=engine();e.ingest([event(B)]);const r=e.ingest([event(A,{usd:2000})]);
 assert.equal(r.length,1);assert.match(r[0].record.detail,/共同买入.*单笔买入/);
 const burst=Array.from({length:500},(_,i)=>event(A,{tx:`burst-${i}`,usd:2000}));
 assert.equal(e.ingest(burst).length,500);assert.equal(e.ingest(burst).length,0);
 pass('两条件同时满足只生成一条；500 笔高频交易分别保留且重扫不重复');
}
{
 const solA='A'.repeat(32),solB='a'.repeat(32);
 const e=engine({amount:{enabled:true,minUsd:10,wallets:[{address:solA}]}});
 assert.equal(e.ingest([event(solB,{chain:'sol',token:'B'.repeat(32),usd:20})]).length,0);
 assert.equal(e.ingest([event(solA,{chain:'sol',token:'B'.repeat(32),usd:20})]).length,1);
 pass('Solana 地址区分大小写');
}
let listener,failWrite=false;const stored={};const pages=[];
const get=async keys=>typeof keys==='string'?{[keys]:stored[keys]}:keys===null?structuredClone(stored):Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,stored[k]??v]));
const set=async values=>{if(failWrite)throw Error('quota');Object.assign(stored,values);await Promise.all(pages.map(p=>p.evaluate(changes=>window.listeners.forEach(f=>f(changes,'local')),Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])))));};
vm.runInNewContext(priority,{URL,chrome:{runtime:{id:'test',onMessage:{addListener:f=>listener=f}},storage:{local:{get,set}}}});
const send=(site,message)=>new Promise(resolve=>listener(message,{id:'test',url:`https://${site}/test`},resolve));
const browser=await chromium.launch({headless:true});
async function fixture(site) {
 const p=await browser.newPage();await p.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="root" style="position:relative;width:430px;height:650px"></div>'}));await p.goto(`https://${site}/test`);
 await p.exposeFunction('send',message=>send(site,message));await p.evaluate(()=>{window.listeners=[];window.chrome={runtime:{sendMessage:window.send},storage:{onChanged:{addListener:f=>listeners.push(f)}}};});
 pages.push(p);await p.addScriptTag({content:source});await p.addScriptTag({content:priority});
 await p.evaluate(config=>{window.go=[];window.api=GdhPriorityPush.create(href=>go.push(href));window.cfg=config;api.setContext(document.querySelector('#root'),40,new Map(),cfg);},config);
 return p;
}
async function add(p,site,tx,usd=2000) {
 await p.evaluate(({site,tx,usd,A,T})=>{
 const row=document.createElement('a');row.href=site==='gmgn.ai'?`/bsc/token/${T}`:`/token/bsc/${T}`;
 const prefix=site==='gmgn.ai'?'gdhTrack':'gdhDebotTrack';
 for(const [k,v] of Object.entries({[site==='gmgn.ai'?'Maker':'Wallet']:A,[site==='gmgn.ai'?'Addr':'Token']:T,Chain:'bsc',Side:'buy',Ts:Date.now()+1,Tx:tx,Usd:usd,Symbol:'测试币'}))row.dataset[prefix+k]=String(v);
 document.querySelector('#root').appendChild(row);window.testRow=row;api.scanBuys([row]);
 },{site,tx,usd,A,T});
}
try {
 const take=(file,name)=>{const s=read(file),i=s.indexOf(`  function ${name}(`);assert.ok(i>=0);return s.slice(i,s.indexOf('\n  }',i)+4);};
 for(const site of ['gmgn.ai','debot.ai'])for(const mode of ['card','list']){
  const p=await fixture(site);
  await p.evaluate(({site,mode})=>{const root=document.querySelector('#root');root.setAttribute(site==='gmgn.ai'?'data-sentry-component':'data-edge-dock-panel',site==='gmgn.ai'?'WalletTrack':'track');root.dataset.mode=mode;}, {site,mode});
  // Use the real host scanner, not a direct api.scanBuys call.
  const declarations=`const settings={enableSpecialWallet:false,priorityBuyStrategies:window.cfg};const priorityPush=window.api;const specialWalletMap=new Map();let specialPinStrip=null;`;
  const scanner=site==='gmgn.ai'?declarations+`const trackerCards=()=>[testRow];`+take('content.js','scanPinnedPush')
   :declarations+`const sidebarTrackLayout=()=>({list:document.querySelector('#root')});const sidebarTrackRows=()=>[testRow];const isTrackShellPage=()=>true;`+take('debot-content.js','scanSidebarFeatures');
  await p.addScriptTag({content:scanner});
  await p.evaluate(()=>{window.originalScan=api.scanBuys;api.scanBuys=()=>{};});
  await add(p,site,`scanner-${mode}`);
  await p.evaluate(site=>{api.scanBuys=originalScan;site==='gmgn.ai'?scanPinnedPush():scanSidebarFeatures();},site);
  await p.waitForSelector('.gdh-priority-push article');
  assert.ok((await p.locator('.gdh-priority-push').innerText()).includes('策略'));
  pass(`${site} ${mode} 实际扫描函数在特别关注关闭时仍接入买入策略`);
 }
 for(const p of pages) await p.close();pages.length=0;
 for(const key of Object.keys(stored)) delete stored[key];
 for(const site of ['gmgn.ai','debot.ai']){
  const p=await fixture(site);await add(p,site,'live-fixture');await p.waitForSelector('.gdh-priority-push article');
  assert.equal(await p.locator('.gdh-priority-push article').count(),1);
  await p.locator('.gdh-priority-push a').click();assert.equal(await p.evaluate(()=>go.length),1);assert.equal(await p.locator('.gdh-priority-push article').count(),1);
  const reload=await fixture(site);await reload.waitForSelector('.gdh-priority-push article');await reload.locator('.gdh-priority-push article>button').click();
  await p.waitForFunction(()=>!document.querySelector('.gdh-priority-push article'));await add(p,site,'live-fixture');await p.waitForTimeout(80);
  assert.equal(await p.locator('.gdh-priority-push article').count(),0);
  failWrite=true;await add(p,site,'retry-fixture');await p.waitForFunction(()=>document.querySelector('.gdh-priority-push header')?.textContent.includes('保存失败'));failWrite=false;
  await p.evaluate(()=>api.scanBuys([testRow]));await p.waitForSelector('.gdh-priority-push article');
  await p.evaluate(()=>api.setContext(document.querySelector('#root'),40,new Map(),{}));assert.equal(await p.locator('.gdh-priority-push').count(),0);
  pass(`${site} 无特别关注也能策略置顶、SPA 点击不消失、刷新恢复、关闭同步与不复活、写失败重试`);
 }
 const p=await fixture('gmgn.ai');
 await p.evaluate(({A,T})=>{const row=document.createElement('a');row.href=`/bsc/token/${T}`;GdhBuyStrategies.tagFeed(row,{source:'pump',pumpWallet:A,addr:T,chain:'bsc',type:'buy',ts:Date.now()+1,tx:'pump-fixture',usd:2000,symbol:'PUMP'});document.querySelector('#root').appendChild(row);api.scanBuys([row]);},{A,T});
 await p.waitForFunction(()=>document.querySelector('.gdh-priority-push')?.textContent.includes('PUMP'));
 pass('具有明确钱包身份的 Pump 混排卡参与策略');
 const ui=await browser.newPage();await ui.setContent(read('popup.html').replace(/<script[^>]*src=[^>]+><\/script>/g,''));await ui.addStyleTag({content:read('popup.css')});await ui.addScriptTag({content:source});
 const popup=read('popup.js');const a=popup.indexOf('function renderBuyStrategies('),b=popup.indexOf("chrome.storage.onChanged.addListener((changes, area) => {",a);
 await ui.addScriptTag({content:'function setStatus(s){document.querySelector("#status").textContent=s;}'+popup.slice(a,b)});
 await ui.evaluate(({A,B})=>{renderBuyStrategies();renderBuyStrategyPickers([{address:A,label:'甲'},{address:B,label:'乙'}]);document.querySelector('#buy-strategy-settings').open=true;},{A,B});
 assert.equal(await ui.locator('#buy-group-enabled').isChecked(),false);assert.equal(await ui.locator('#buy-amount-enabled').isChecked(),false);
 await ui.locator('#buy-group-picker').selectOption({label:`甲 · ${A.slice(0,6)}…${A.slice(-4)}`});await ui.locator('#buy-group-picker').selectOption({label:`乙 · ${B.slice(0,6)}…${B.slice(-4)}`});await ui.locator('#buy-group-enabled').check();
 assert.equal(await ui.evaluate(()=>readBuyStrategies().group.wallets.length),2);
 await ui.locator('#buy-amount-wallets').fill('同名人物');assert.match(await ui.evaluate(()=>{try{readBuyStrategies();return '';}catch(e){return e.message}}),/完整/);
 await ui.locator('#buy-amount-wallets').fill(`${A} 甲`);await ui.locator('#buy-amount-enabled').check();await ui.locator('#buy-amount-usd').fill('2000');
 assert.equal(await ui.evaluate(()=>readBuyStrategies().amount.minUsd),2000);
 await ui.locator('#buy-strategy-settings').screenshot({path:new URL('../dist/buy-strategies-settings.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1')});
 pass('真实设置字段默认关闭、从特别关注选人、无效输入拦截、两种条件独立保存');
 console.log(`1..${checks}`);
} finally {await browser.close();}
