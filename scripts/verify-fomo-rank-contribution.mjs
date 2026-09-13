import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {createCollector,normalizeBoards}=createRequire(import.meta.url)('../server/fomo-rank-collector.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gdh-rank-test-'));
let n=0;const pass=s=>console.log(`PASS ${++n}: ${s}`);
const rows=()=>Array.from({length:35},(_,i)=>({rank:i+1,uid:`u${i}`,handle:`user${i}`,name:`人物${i}`,pnl:1000-i,token:'never-store-me'}));
const boards=()=>Object.fromEntries(['all','30d','7d','24h'].map(k=>[k,rows()]));
try {
  let now=1800000000000;const sent=[],sizes=[];
  const ctx=(user,id)=>({userId:user,extensionSession:{id}});
  const client=(user,id,enabled=true)=>({userCtx:ctx(user,id),extensionFeedOnly:true,fomoRankCollectorReady:enabled,res:{write:s=>sent.push({user,id,s})}});
  const clients=[client('A','a1'),client('A','a2'),client('B','b1'),client('C','c1',false)];
  const snapshotPath=path.join(temp,'public.json');const original={updatedAt:1,boards:{},commonFollowing:['keep'],alliances:['keep-clans']};
  fs.writeFileSync(snapshotPath,JSON.stringify(original));
  const options={dataDir:temp,snapshotPath,clients:()=>clients,now:()=>now,random:max=>{sizes.push(max);return max-1;}};
  let collector=createCollector(options);collector.tick();
  assert.equal(sent.length,1);assert.equal(sent[0].user,'B');assert.deepEqual(sizes,[2,1]);
  const job=JSON.parse(sent[0].s.match(/data: (.+)/)[1]);
  pass('仅选择自愿参与的在线会话，按账号去重后随机抽取');
  assert.equal(collector.accept(ctx('A','a1'),{id:job.id,ok:true,boards:boards()}).status,409);
  const partial=boards();delete partial['24h'];assert.equal(collector.accept(ctx('B','b1'),{id:job.id,ok:true,boards:partial}).status,400);
  const bad=boards();bad.all[0].pnl=null;assert.equal(collector.accept(ctx('B','b1'),{id:job.id,ok:true,boards:bad}).status,400);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath)),original);
  pass('错误会话、不完整四榜和无效盈亏均拒绝，旧数据不变');
  assert.equal(collector.accept(ctx('B','b1'),{id:job.id,ok:true,boards:boards()}).body.published,true);
  const published=JSON.parse(fs.readFileSync(snapshotPath));assert.equal(published.boards.all.length,30);assert.deepEqual(published.alliances,original.alliances);assert.deepEqual(published.commonFollowing,original.commonFollowing);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp,'fomo-browser-leaderboards.json'))).boards.all.length,35);
  assert.ok(!fs.readFileSync(snapshotPath,'utf8').includes('never-store-me'));
  pass('全量贡献存服务端缓存，公开页保持前 30 名并保留联盟与共同关注');
  collector.tick();collector=createCollector(options);collector.tick();assert.equal(sent.length,1);
  assert.equal(collector.accept(ctx('B','b1'),{id:job.id,ok:true,boards:boards()}).status,409);
  pass('服务重启、重复上传都不会重复分配或覆盖已完成的任务');
  now+=3600000;collector.tick();assert.equal(sent.length,2);const job2=JSON.parse(sent[1].s.match(/data: (.+)/)[1]);
  collector.accept(ctx('B','b1'),{id:job2.id,ok:false,status:429,retryAfterMs:13*3600000});
  assert.ok(collector.status().nextAttemptAt>=now+13*3600000);now+=3600000;collector.tick();assert.equal(sent.length,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath)),published);
  pass('403/429 等失败不换用户重试，至少 12 小时退避并尊重更长 Retry-After');
  assert.throws(()=>normalizeBoards({...boards(),all:[...rows()].reverse()}));pass('拒绝乱序排名和非有限数值');

  const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function fomoRankContributionAllowed'),source.indexOf('async function connectFomoSse'));
  async function exercise(mode){
    const store={enabled:mode!=='master-disabled',enableFomoRankContribution:mode==='legacy',fomoRankCollectorConsentV1:mode==='disabled'?null:{version:1,acceptedAt:Date.now()},fomoToken:{token:'private-fomo-fixture-token',exp:Date.now()+3600000}};
    const calls=[];let upstream=0;
    const context={AbortController,AbortSignal,URL,Response,setTimeout,clearTimeout,
      chrome:{storage:{local:{get:async keys=>typeof keys==='string'?{[keys]:store[keys]}:{...keys,...Object.fromEntries(Object.keys(keys).filter(k=>k in store).map(k=>[k,store[k]]))},set:async values=>Object.assign(store,values)}},tabs:{query:async()=>[{}],onCreated:{addListener(){}},onRemoved:{addListener(){}},onUpdated:{addListener(){}}}},
      monitor985Session:async()=>({token:'monitor-only'}),monitor985AuthHeaders:(s,h)=>({...h,Authorization:`Bearer ${s.token}`}),
      MONITOR985_ORIGIN:'https://www.985monitor.xyz',FOMO_API:'https://prod-api.fomo.family',FOMO_CHAINS:'1,56',fomoQueuedFetch:fn=>fn(),
      fetch:async(url,init)=>{calls.push({url,init});if(url.startsWith('https://prod-api.fomo.family')){upstream++;
        if(mode==='403'&&upstream===2)return new Response('{}',{status:403});
        if(mode==='cancel'&&upstream===1)store.fomoRankCollectorConsentV1=null;
        const data=rows().map(r=>({id:r.uid,userHandle:r.handle,displayName:r.name,totalPnL:r.pnl,pnl30d:r.pnl,pnl7d:r.pnl,pnl24h:r.pnl}));
        if(mode==='bad-pnl')delete data[0].totalPnL;
        return Response.json({success:true,statusCode:200,responseObject:data});
      }return Response.json({ok:true,accepted:JSON.parse(init.body).ok,published:true});},
    };vm.createContext(context);vm.runInContext(code,context);
    const task={id:'11111111-1111-1111-1111-111111111111',version:1,expiresAt:Date.now()+120000};
    await context.collectFomoRankTask(task);await context.collectFomoRankTask(task);
    const upload=calls.filter(c=>c.url.startsWith('https://www.985monitor.xyz'));
    assert.equal(upload.length,1);assert.ok(!JSON.stringify(upload).includes('private-fomo-fixture-token'));
    return {upstream,body:JSON.parse(upload[0].init.body),status:store.fomoRankCollectorStatusV1};
  }
  const ok=await exercise('success');assert.equal(ok.upstream,4);assert.equal(ok.body.ok,true);assert.equal(ok.status.status,'uploaded');pass('插件只读四个固定官方接口；上传仅有白名单字段，不泄露 FOMO 令牌');
  const denied=await exercise('403');assert.equal(denied.upstream,2);assert.equal(denied.body.ok,false);assert.equal(denied.body.status,403);assert.equal(denied.body.boards,undefined);pass('第二个榜拒绝后不再请求其余榜，不上传部分结果');
  const legacy=await exercise('legacy');assert.equal(legacy.upstream,4);const disabled=await exercise('disabled');assert.equal(disabled.upstream,0);const masterDisabled=await exercise('master-disabled');assert.equal(masterDisabled.upstream,0);const cancelled=await exercise('cancel');assert.equal(cancelled.upstream,1);assert.equal(cancelled.body.boards,undefined);pass('未确认更新、总开关禁用与采集中撤回授权均不继续访问 FOMO');
  const malformed=await exercise('bad-pnl');assert.equal(malformed.upstream,1);assert.equal(malformed.body.ok,false);pass('缺失盈亏字段不被错误转换为 0 后上传');
  now=collector.status().nextAttemptAt;collector.tick();const beforeTimeout=sent.length;
  const expiredJob=JSON.parse(sent.at(-1).s.match(/data: (.+)/)[1]);
  now+=180001;collector.tick();
  assert.equal(sent.length,beforeTimeout);assert.equal(collector.accept(ctx('B','b1'),{id:expiredJob.id,ok:true,boards:boards()}).status,409);
  collector=createCollector(options);collector.tick();assert.equal(sent.length,beforeTimeout);
  pass('任务超时与服务重启不会在同一小时重新选人，迟到上传被拒绝');
  now=collector.status().nextAttemptAt;collector.tick();const latestJob=JSON.parse(sent.at(-1).s.match(/data: (.+)/)[1]);
  const official={...published,updatedAt:now+1,leaderboardSource:'official'};fs.writeFileSync(snapshotPath,JSON.stringify(official));now+=2;
  assert.equal(collector.accept(ctx('B','b1'),{id:latestJob.id,ok:true,boards:boards()}).body.published,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshotPath)),official);
  pass('采集期间官方已发布较新快照时不覆盖，只保存贡献缓存');
  console.log(`1..${n}`);
}finally{const absolute=fs.realpathSync(temp);const parent=fs.realpathSync(os.tmpdir());if(path.dirname(absolute)!==parent||!path.basename(absolute).startsWith('gdh-rank-test-'))throw Error('unsafe test cleanup');fs.rmSync(absolute,{recursive:true});}
