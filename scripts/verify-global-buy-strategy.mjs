// Offline fixtures only: no real settings, tracking lists, network or trades.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = n => fs.readFileSync(new URL('../' + n, import.meta.url), 'utf8');
const source = read('buy-strategies.js'), priority = read('priority-push.js'), ctx = {};
vm.runInNewContext(source, ctx); const S = ctx.GdhBuyStrategies, clone = x => JSON.parse(JSON.stringify(x));
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), T = '0x' + 'a'.repeat(40), U = '0x' + 'b'.repeat(40);
let now = 1800000000000, seq = 0, checks = 0;
const pass = n => console.log(`PASS ${++checks}: ${n}`);
const config = extra => S.normalizeGlobal({ enabled: true, ...extra });
const buy = extra => ({ wallet: A, token: T, chain: 'bsc', side: 'buy', ts: now, tx: 'tx-' + ++seq,
  source: 'tracking', usd: 500, symbol: '测试币', href: `/bsc/token/${T}`, ...extra });
const engine = global => { const e = S.create(() => now); e.configure({ groups: [], global: global || config() }); return e; };
assert.equal(S.normalizeGlobal().enabled, false);
assert.equal(S.normalizeGlobal({enabled:true, sources:[]}).enabled, false);
for (const invalid of [{singleUsd:NaN}, {windowSeconds:0}, {windowBuyers:1.2}, {chain:'bad'}, {sources:['bad']}, {singleEnabled:false,windowEnabled:false}])
  assert.throws(() => S.validateGlobal({...clone(config()),...invalid}));
pass('默认关闭、无效规则不启用，保存严格校验');
{
  const e = engine(), old = buy({ ts: now-1, usd:5000 }), later = buy({usd:null});
  assert.equal(e.ingest([old,buy({side:'sell',usd:5000}),buy({ts:now+6000,usd:5000}),buy({usd:1000}),later]).length,0);
  const hit=e.ingest([{...later,usd:1000.01}]); assert.equal(hit.length,1); assert.equal(hit[0].record.strategyGlobal,true);
  assert.equal(e.ingest([buy({usd:9000}),{...later,usd:9000}]).length,0);
  assert.equal(e.ingest([buy({chain:'eth',usd:9000})]).length,1);
  assert.equal(e.ingest([buy({token:U,usd:9000})]).length,1);
  assert.equal(e.current(hit[0]),true);e.configure({global:config({enabled:false})});assert.equal(e.current(hit[0]),false);
  pass('严格大于 USD，金额晚到补判、历史/未来/卖出隔离、同链同币同条件只报一次');
}
{
  const c=config({singleEnabled:false,windowEnabled:true,windowSeconds:10,windowUsd:1000,windowBuyers:2}),e=engine(c);
  const a=buy({usd:600}),b=buy({wallet:B,usd:400});
  assert.equal(e.ingest([a,b]).length,0);assert.equal(e.ingest([a,b]).length,0);
  assert.equal(e.ingest([buy({usd:1})]).length,1);
  assert.equal(e.ingest([buy({usd:5000})]).length,0);
  const f=engine(c);f.ingest([buy({usd:9999})]);now+=11000;assert.equal(f.ingest([buy({wallet:B,usd:1})]).length,0);
  assert.equal(f.ingest([buy({chain:'eth',usd:9999}),buy({token:U,usd:9999})]).length,0);
  pass('窗口金额与人数为 AND、同人多笔不凑人数，超时/跨链/跨币不拼单');
}
{
  const c=config({singleEnabled:false,windowEnabled:true,windowUsd:1000,windowBuyers:2}),e=engine(c);
  const native=buy({usd:600,tx:'shared'}),pump={...native,source:'pump'},fomo={...native,wallet:'',source:'fomo',handle:'ALICE'};
  assert.equal(e.ingest([native,pump,fomo]).length,0);
  assert.equal(e.ingest([buy({usd:401,wallet:B})]).length,1);
  const f=engine(config({singleEnabled:false,windowEnabled:true,windowUsd:0,windowBuyers:2}));
  assert.equal(f.ingest([buy({source:'fomo',wallet:'',handle:'alice',usd:null}),buy({source:'fomo',wallet:'',handle:'alice',usd:null})]).length,0);
  assert.equal(f.ingest([buy({source:'fomo',wallet:'',handle:'bob',usd:null})]).length,1);
  const g=engine(config({singleEnabled:false,windowEnabled:true,windowUsd:1000,windowBuyers:0}));
  assert.equal(g.ingest([buy({usd:null}),buy({usd:Infinity}),buy({usd:600})]).length,0);
  assert.equal(g.ingest([buy({usd:401})]).length,1);
  pass('精确交易跨来源去重、FOMO 用账号而非昵称、未知金额不凑数，0 可忽略单项门槛');
}
{
  const e=engine(config({chain:'arc',sources:['pump']}));
  assert.equal(e.ingest([buy({usd:5000}),buy({chain:'arc',usd:5000})]).length,0);
  assert.equal(e.ingest([buy({chain:'arc',source:'pump',usd:5000})]).length,1);
  const f=engine(config({singleEnabled:false,windowEnabled:true,windowBuyers:2}));
  f.ingest([buy()]);f.configure({global:config({singleEnabled:false,windowEnabled:true,windowBuyers:2}),groups:[{id:'x',name:'X',enabled:false,conditions:{}}]});
  assert.equal(f.ingest([buy({wallet:B})]).length,1);
  pass('链和来源过滤生效，编辑人物组不重置全局累计');
}
let stored={priorityBuyStrategies:{groups:[]}}, fail=false;const listeners=[],pages=[];
const get=async keys=>keys===null?clone(stored):typeof keys==='string'?{[keys]:clone(stored[keys]??null)}:Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,clone(stored[k]??v)]));
const set=async values=>{if(fail)throw Error('fixture quota');Object.assign(stored,clone(values));await Promise.all(pages.filter(p=>!p.isClosed()).map(p=>p.evaluate(v=>listeners.forEach(f=>f(v,'local')),Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])))));};
const worker={URL,chrome:{runtime:{id:'fixture',onMessage:{addListener:f=>listeners.push(f)}},storage:{local:{get,set}}}};
vm.runInNewContext(source,worker);vm.runInNewContext(priority,worker);
const send=(message,url='https://gmgn.ai/test')=>new Promise(resolve=>{for(const f of listeners)if(f(message,{id:'fixture',url},resolve)===true)return;});
const save=(global,expected=JSON.stringify(S.normalizeGlobal(stored.priorityBuyStrategies?.global)))=>send({type:'buy-strategy-update',action:'global-save',global:clone(global),expected});
{
  const group={id:'one',name:'人物一',enabled:false,conditions:clone(S.normalize())};
  const [a,b]=await Promise.all([save(config()),send({type:'buy-strategy-update',action:'save',id:'one',expected:null,group})]);
  assert.ok(a.ok&&b.ok);assert.equal(stored.priorityBuyStrategies.global.enabled,true);assert.equal(stored.priorityBuyStrategies.groups[0].name,'人物一');
  const base=JSON.stringify(stored.priorityBuyStrategies.global);
  const r=await Promise.all([save(config({singleUsd:2000}),base),save(config({singleUsd:3000}),base)]);
  assert.equal(r.filter(v=>v.ok).length,1);assert.equal(r.filter(v=>v.conflict).length,1);
  const before=JSON.stringify(stored);fail=true;assert.equal((await save(config())).ok,false);fail=false;assert.equal(JSON.stringify(stored),before);
  assert.equal((await save({...clone(config()),windowSeconds:-1})).ok,false);assert.equal(JSON.stringify(stored),before);
  pass('后台串行合并全局与人物组、全局并发冲突和写失败保留配置');
}
const browser=await chromium.launch({headless:true});
async function fixture(site='gmgn.ai') {
  const p=await browser.newPage({viewport:{width:700,height:1100}});p._errors=[];p.on('pageerror',e=>p._errors.push(e.message));
  await p.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<body style="background:#101216;color:#eee"><div id="editor" style="width:460px"></div><div id="root" style="position:relative;width:460px;height:400px"></div></body>'}));await p.goto(`https://${site}/test`);
  await p.exposeFunction('hostGet',get);await p.exposeFunction('hostSet',set);await p.exposeFunction('hostMessage',m=>send(m,`https://${site}/test`));
  await p.evaluate(()=>{window.listeners=[];window.chrome={runtime:{sendMessage:hostMessage},storage:{local:{get:hostGet,set:hostSet},onChanged:{addListener:f=>listeners.push(f)}}};});
  pages.push(p);await p.addStyleTag({content:read(site==='gmgn.ai'?'styles.css':'debot-styles.css')});await p.addScriptTag({content:source});await p.addScriptTag({content:priority});
  await p.evaluate(async()=>{const data=await chrome.storage.local.get('priorityBuyStrategies');window.api=GdhBuyStrategies.createEditor(document.querySelector('#editor'),data.priorityBuyStrategies,[]);window.alerts=GdhPriorityPush.create(()=>{});window.cfg=data.priorityBuyStrategies;alerts.setContext(document.querySelector('#root'),0,new Map(),cfg);listeners.push(c=>{if(c.priorityBuyStrategies){cfg=c.priorityBuyStrategies.newValue;api.sync(cfg,[]);alerts.setContext(document.querySelector('#root'),0,new Map(),cfg);}});});
  return p;
}
const field=(p,k)=>p.locator(`[data-global="${k}"]`);
try {
  stored={priorityBuyStrategies:{groups:[]}};
  const a=await fixture(),b=await fixture('debot.ai');
  await a.locator('.gdh-strategy-global summary').click();assert.match(await a.locator('.gdh-strategy-global').innerText(),/Global alerts/);assert.equal(await field(a,'enabled').isChecked(),false);
  await a.locator('.gdh-strategy-language').selectOption('zh');await field(a,'enabled').check();await field(a,'singleUsd').fill('2500');
  await a.locator('.gdh-global-save').click();await a.waitForFunction(()=>document.querySelector('.gdh-strategy-global-status').textContent.includes('已保存'));
  assert.equal(stored.priorityBuyStrategies.global.singleUsd,2500);assert.equal(await field(b,'singleUsd').inputValue(),'2500');
  await field(a,'singleUsd').fill('3000');await b.locator('.gdh-strategy-global summary').click();await field(b,'singleUsd').fill('4000');await b.locator('.gdh-global-save').click();
  await a.waitForFunction(()=>document.querySelector('.gdh-global-save').disabled);assert.equal(await field(a,'singleUsd').inputValue(),'3000');
  await a.getByRole('button',{name:'重新读取全局设置',exact:true}).click();assert.equal(await field(a,'singleUsd').inputValue(),'4000');
  await field(a,'windowEnabled').check();await field(a,'windowUsd').fill('10000');await field(a,'windowBuyers').fill('3');
  await a.locator('.gdh-strategy-language').selectOption('en');assert.equal(await field(a,'windowUsd').inputValue(),'10000');
  await a.locator('#editor').screenshot({path:'dist/global-strategy-v97.png'});
  pass('GMGN/DeBot 共享编辑器独立保存同步；冲突留草稿；中英文切换不丢输入');
  await a.close();await b.close();
  stored={priorityBuyStrategies:{groups:[],global:clone(config())}};
  for(const site of ['gmgn.ai','debot.ai']) {
    const p=await fixture(site);
    const insert=async page=>page.evaluate(({T})=>{const row=document.createElement('div');row.className='gdh-fomofeed';GdhBuyStrategies.tagFeed(row,{source:'fomo',handle:'fixture-account',key:'fixture-fomo',addr:T,chain:'bsc',type:'buy',usd:5000,ts:Date.now()+1,symbol:'GLOBAL'});document.querySelector('#root').append(row);alerts.scanBuys([row]);},{T});
    await insert(p);await p.waitForSelector('.gdh-priority-push article');assert.match(await p.locator('.gdh-priority-push article').innerText(),/全局买入/);
    await p.locator('.gdh-priority-push article > button').click();await p.waitForFunction(()=>!document.querySelector('.gdh-priority-push article'));
    const reload=await fixture(site);await insert(reload);await reload.waitForTimeout(100);assert.equal(await reload.locator('.gdh-priority-push article').count(),0);
    await p.close();await reload.close();
  }
  pass('无钱包 FOMO 可全局置顶，两站同币按条件持久化去重，手动关闭和重新打开不复活');
  for(const p of pages)assert.deepEqual(p._errors,[]);
  console.log(`1..${checks}`);
} finally { await browser.close(); }
