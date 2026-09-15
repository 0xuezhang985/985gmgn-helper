import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('buy-strategies.js'), priority = read('priority-push.js');
const ctx = {}; vm.runInNewContext(source, ctx); const S = ctx.GdhBuyStrategies;
const clone = x => JSON.parse(JSON.stringify(x));
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), T = '0x' + '3'.repeat(40);
const conditions = S.normalize({ group: { enabled: true, wallets: [{address:A,label:'甲'}, {address:B,label:'乙'}], windowSeconds: 300 } });
const group = (id, extra = {}) => ({ id, name: id, enabled: true, conditions: clone(conditions), ...extra });
const amount = minUsd => S.normalize({ amount: { enabled: true, wallets: [{address:A,label:'甲'}], minUsd } });
let checks = 0; const pass = text => console.log(`PASS ${++checks}: ${text}`);
let now = 1800000000000;
const event = (wallet, tx, usd = 100) => ({ wallet, token:T, chain:'bsc', side:'buy', ts:now, tx, usd, symbol:'测试币', href:`/bsc/token/${T}` });
{
  const engine = S.create(() => now), first = group('first'), second = group('second', {conditions:amount(1000)});
  engine.configure({groups:[first,second]}); assert.equal(engine.ingest([event(A,'a')]).length,0);
  const high = engine.ingest([event(A,'high',2000)]); assert.equal(high[0].record.strategyGroup,'second');
  now += 1000; second.conditions = amount(3000); engine.configure({groups:[first,second]});
  assert.equal(engine.ingest([event(B,'b')])[0].record.strategyGroup,'first');
  first.enabled = false; engine.configure({groups:[first,second]});
  assert.equal(engine.ingest([event(A,'new-high',4000)])[0].record.strategyGroup,'second');
  assert.equal(engine.current(high[0]),false);
  pass('修改/关闭一组不重置其他组的共买累计与去重，过期待发送提醒失效');
}
{
  const engine = S.create(() => now), one = group('one',{conditions:amount(1000)}), two = group('two',{conditions:amount(2000)});
  engine.configure({groups:[one,two]}); const alerts=engine.ingest([event(A,'both',3000)]);
  assert.equal(alerts.length,2); assert.notEqual(alerts[0].key,alerts[1].key);
  assert.deepEqual(clone(alerts.map(a=>a.record.strategyGroup)),['one','two']);
  engine.configure({groups:[two,one]}); assert.equal(engine.ingest([event(A,'both',3000)]).length,0);
  now+=1000; one.enabled=false;engine.configure({groups:[one,two]});one.enabled=true;engine.configure({groups:[one,two]});
  assert.equal(engine.ingest([{...event(A,'old',3000),ts:now-500}]).filter(a=>a.record.strategyGroup==='one').length,0);
  pass('同笔命中两组分别显示组名，调整顺序不重报，重新启用不回放旧成交');
}
let stored = {}, failWrite = false, listeners = [], pages = [];
const get = async keys => keys===null ? clone(stored) : typeof keys==='string' ? {[keys]:clone(stored[keys] ?? null)}
  : Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,clone(stored[k]??v)]));
const set = async next => {
  if (failWrite) throw Error('模拟存储失败');
  const changes=Object.fromEntries(Object.entries(next).map(([k,v])=>[k,{newValue:clone(v)}])); Object.assign(stored,clone(next));
  await Promise.all(pages.filter(p=>!p.isClosed()).map(p=>p.evaluate(changes=>window.storageListeners.forEach(f=>f(changes,'local')),changes)));
};
const worker = { URL, chrome:{runtime:{id:'test',onMessage:{addListener:f=>listeners.push(f)}},storage:{local:{get,set}}} };
vm.runInNewContext(source,worker); vm.runInNewContext(priority,worker);
const send = (message,url='https://gmgn.ai/test',id='test') => new Promise(resolve=>{
  for (const listener of listeners) if (listener(message,{url,id},resolve) === true) return;
});
const write = (id, action, extra={}, expected) => {
  const current=S.normalizeGroups(stored.priorityBuyStrategies).groups.find(g=>g.id===id);
  return send({type:'buy-strategy-update',id,action,expected:expected===undefined?(current?JSON.stringify(current):null):expected,...extra});
};
{
  stored.priorityBuyStrategies=clone(conditions);
  const replies=await Promise.all([write('alpha','save',{group:group('alpha')}),write('beta','save',{group:group('beta')})]);
  assert.ok(replies.every(r=>r.ok)); assert.equal(stored.priorityBuyStrategies.groups.length,3);
  assert.equal(stored.priorityBuyStrategies.groups[0].id,'legacy');assert.equal(stored.priorityBuyStrategies.groups[0].enabled,true);
  const base=JSON.stringify(stored.priorityBuyStrategies.groups.find(g=>g.id==='alpha'));
  const competing=await Promise.all([write('alpha','save',{group:group('alpha',{name:'修改一'})},base),write('alpha','save',{group:group('alpha',{name:'修改二'})},base)]);
  assert.equal(competing.filter(r=>r.ok).length,1);assert.equal(competing.filter(r=>r.conflict).length,1);
  const [x,y]=await Promise.all([write('alpha','toggle',{enabled:false}),write('beta','toggle',{enabled:false})]);assert.ok(x.ok&&y.ok);
  assert.equal(stored.priorityBuyStrategies.groups[0].enabled,true);
  pass('真实后台串行合并不同组并保留旧配置；同组并发写提示冲突，其他组开关不被覆盖');
  const before=JSON.stringify(stored);failWrite=true;assert.equal((await write('alpha','toggle',{enabled:true})).ok,false);failWrite=false;
  assert.equal(JSON.stringify(stored),before);
  assert.equal((await write('bad','save',{group:group('bad',{conditions:{amount:{enabled:true,wallets:[{address:A}],minUsd:-1}}})})).ok,false);
  assert.equal((await send({type:'buy-strategy-update'},'https://gmgn.ai.attacker.test')).ok,false);
  assert.equal((await send({type:'buy-strategy-update'},'https://gmgn.ai/test','wrong')).ok,false);
  for(let i=3;i<20;i++)assert.equal((await write('g'+i,'save',{group:group('g'+i,{enabled:false})})).ok,true);
  assert.equal((await write('overflow','save',{group:group('overflow')})).ok,false);
  pass('来源校验、无效条件、写失败不损坏配置，最多保存 20 组');
}
stored={priorityBuyStrategies:{},specialWallets:[{address:A,label:'甲'},{address:B,label:'乙'}]};
const browser=await chromium.launch({headless:true});
async function fixture(site,popup=false){
  const p=await browser.newPage({viewport:{width:700,height:950}});const errors=[];p.on('pageerror',e=>errors.push(e.message));p._errors=errors;
  await p.route('**/*',route=>route.fulfill({contentType:'text/html',body:popup?read('popup.html').replace(/<script[^>]*src=[^>]+><\/script>/g,''):'<div id="editor" style="width:420px;background:#16181d;color:#eee"></div><div id="alerts" style="position:relative;width:420px;height:500px"></div>'}));
  await p.goto(`https://${site}/test`);
  await p.exposeFunction('hostMessage',message=>send(message,popup?'chrome-extension://test/popup.html':`https://${site}/test`));
  await p.exposeFunction('hostGet',get);await p.exposeFunction('hostSet',set);
  await p.evaluate(()=>{
    window.storageListeners=[];window.confirmResult=true;window.confirm=()=>confirmResult;
    window.chrome={runtime:{id:'test',getManifest:()=>({version:'0.46.83'}),sendMessage:(m,cb)=>{
      const result=['buy-strategy-update','priority-push-list','priority-push-add','priority-push-dismiss'].includes(m.type)?hostMessage(m):Promise.resolve({status:'latest',currentVersion:'0.46.83',latestVersion:'0.46.83',updateAvailable:false});
      if(cb){result.then(cb);return;}return result;
    }},storage:{onChanged:{addListener:f=>storageListeners.push(f)},local:{
      get:(keys,cb)=>{const r=hostGet(keys);if(cb){r.then(cb);return;}return r;},
      set:(value,cb)=>{const r=hostSet(value);if(cb){r.then(()=>cb());return;}return r;},
    }},tabs:{create:()=>{}}};
  });
  pages.push(p);await p.addStyleTag({content:read(popup?'popup.css':site==='gmgn.ai'?'styles.css':'debot-styles.css')});await p.addScriptTag({content:source});
  if(popup){await p.addScriptTag({content:read('popup.js')});await p.waitForSelector('[data-buy=name]',{state:'attached'});await p.locator('#buy-strategy-settings').evaluate(e=>e.open=true);}
  else await p.evaluate(async()=>{
    const s=await chrome.storage.local.get({priorityBuyStrategies:{},specialWallets:[]});window.config=s.priorityBuyStrategies;
    window.editor=GdhBuyStrategies.createEditor(document.querySelector('#editor'),config,s.specialWallets);
    storageListeners.push(changes=>{if(changes.priorityBuyStrategies){config=changes.priorityBuyStrategies.newValue;editor.sync(config,s.specialWallets);}});
  });
  return p;
}
const field=(p,key)=>p.locator(`[data-buy="${key}"]`);
const row=(p,id)=>p.locator(`[data-group-id="${id}"]`);
const select=(p,id)=>row(p,id).locator('button').click();
const save=p=>p.getByRole('button',{name:'保存本组',exact:true}).click();
try{
  const gmgn=await fixture('gmgn.ai'),debot=await fixture('debot.ai'),popup=await fixture('extension.test',true);
  await field(gmgn,'name').fill('核心人物');await field(gmgn,'group-enabled').check();await field(gmgn,'group-wallets').fill(`${A} 甲\n${B} 乙`);await field(gmgn,'group-window').fill('60');await save(gmgn);
  await gmgn.waitForFunction(()=>document.querySelector('.gdh-strategy-status').textContent.includes('已保存'));
  assert.equal(stored.priorityBuyStrategies.groups[0].enabled,false);await row(gmgn,'legacy').locator('input').click();
  await debot.waitForFunction(()=>document.querySelector('[data-group-id=legacy] input').checked);
  assert.equal(await row(popup,'legacy').locator('input').isChecked(),true);
  await gmgn.getByRole('button',{name:'+ 新增策略',exact:true}).click();await field(gmgn,'name').fill('大额提醒');await field(gmgn,'amount-enabled').check();await field(gmgn,'amount-wallets').fill(`${A} 甲`);await field(gmgn,'amount-usd').fill('2500');await save(gmgn);
  await gmgn.waitForFunction(()=>document.querySelector('.gdh-strategy-status').textContent.includes('已保存'));
  const second=stored.priorityBuyStrategies.groups.find(g=>g.name==='大额提醒').id;
  await row(gmgn,second).locator('input').click();await debot.waitForFunction(id=>document.querySelector(`[data-group-id="${id}"] input`).checked,second);
  assert.equal(stored.priorityBuyStrategies.groups.length,2);assert.equal(await popup.locator('.gdh-strategy-group').count(),2);
  pass('实际 GMGN / DeBot / 插件设置共享多组编辑器，创建、命名、保存与独立启用即时同步');
  await select(gmgn,'legacy');await field(gmgn,'group-window').fill('777');await select(gmgn,second);await field(gmgn,'amount-usd').fill('3500');await select(gmgn,'legacy');assert.equal(await field(gmgn,'group-window').inputValue(),'777');await save(gmgn);
  await gmgn.waitForFunction(()=>document.querySelector('.gdh-strategy-status').textContent.includes('已保存'));
  assert.equal(stored.priorityBuyStrategies.groups.find(g=>g.id===second).conditions.amount.minUsd,2500);
  await select(gmgn,second);assert.equal(await field(gmgn,'amount-usd').inputValue(),'3500');
  await select(debot,second);await field(debot,'amount-usd').fill('5000');await save(debot);
  await gmgn.waitForFunction(()=>document.querySelector('.gdh-strategy-save').disabled);assert.equal(await field(gmgn,'amount-usd').inputValue(),'3500');
  await gmgn.getByRole('button',{name:'重新读取',exact:true}).click();await gmgn.waitForFunction(()=>document.querySelector('[data-buy=amount-usd]').value==='5000');
  await select(gmgn,'legacy');await field(gmgn,'group-window').fill('888');await row(debot,second).locator('input').click();
  await gmgn.waitForFunction(id=>!document.querySelector(`[data-group-id="${id}"] input`).checked,second);assert.equal(await field(gmgn,'group-window').inputValue(),'888');assert.equal(await row(gmgn,'legacy').locator('input').isChecked(),true);
  pass('切组保留多个草稿，保存仅影响本组；其他组开关不影响草稿，同组冲突不会静默覆盖');
  await debot.getByRole('button',{name:'删除本组',exact:true}).click();await gmgn.waitForFunction(()=>document.querySelectorAll('.gdh-strategy-group').length===1);
  assert.equal(await field(gmgn,'group-window').inputValue(),'888');await gmgn.close();
  const reloaded=await fixture('gmgn.ai');assert.equal(await field(reloaded,'group-window').inputValue(),'777');assert.equal(await row(reloaded,'legacy').locator('input').isChecked(),true);
  const before=JSON.stringify(stored.priorityBuyStrategies);await popup.locator('#save').click();await popup.waitForTimeout(50);assert.equal(JSON.stringify(stored.priorityBuyStrategies),before);
  pass('删除仅作用于本组；重新打开读取持久化配置，保存全部设置不覆盖策略');
  await reloaded.getByRole('button',{name:'+ 新增策略',exact:true}).click();await field(reloaded,'name').fill('失败重试');failWrite=true;await save(reloaded);await reloaded.waitForFunction(()=>document.querySelector('.gdh-strategy-status').textContent.includes('保存失败'));assert.equal(await field(reloaded,'name').inputValue(),'失败重试');failWrite=false;await save(reloaded);await reloaded.waitForFunction(()=>document.querySelector('.gdh-strategy-status').textContent.includes('已保存'));
  assert.equal(stored.priorityBuyStrategies.groups.find(g=>g.name==='失败重试').enabled,false);
  await reloaded.screenshot({path:new URL('../dist/strategy-groups-gmgn.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
  await popup.locator('#buy-strategy-settings').screenshot({path:new URL('../dist/strategy-groups-popup.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
  pass('新组保存失败完整保留输入，可重试；成功保存不自动开启新组');
  await set({priorityBuyStrategies:{version:2,groups:[group('one',{conditions:amount(1000)}),group('two',{conditions:amount(2000)})]}});
  await reloaded.addScriptTag({content:priority});await reloaded.evaluate(({A,T})=>{
    window.api=GdhPriorityPush.create(()=>{});api.setContext(document.querySelector('#alerts'),0,new Map(),config);
    const row=document.createElement('a');row.href=`/bsc/token/${T}`;Object.assign(row.dataset,{gdhTrackMaker:A,gdhTrackAddr:T,gdhTrackChain:'bsc',gdhTrackSide:'buy',gdhTrackTs:String(Date.now()+1),gdhTrackTx:'both-groups',gdhTrackUsd:'3000',gdhTrackSymbol:'币'});api.scanBuys([row]);
  },{A,T});
  await reloaded.waitForFunction(()=>document.querySelectorAll('.gdh-priority-push article').length===2);
  assert.ok(Object.values(stored).filter(r=>r?.strategy).every(r=>['one','two'].includes(r.strategyGroup)));
  const cfg=clone(stored.priorityBuyStrategies);cfg.groups[0].enabled=false;await set({priorityBuyStrategies:cfg});await reloaded.evaluate(()=>api.setContext(document.querySelector('#alerts'),0,new Map(),config));
  assert.equal(await reloaded.locator('.gdh-priority-push article').count(),1);assert.match(await reloaded.locator('.gdh-priority-push b').innerText(),/^two/);
  for(const p of pages)assert.deepEqual(p._errors,[]);
  pass('真实置顶存储保留所属组；同笔多组分别提醒，停用一组只隐藏本组置顶');
  console.log(`1..${checks}`);
}finally{await browser.close();}
