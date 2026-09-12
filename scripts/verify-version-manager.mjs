// Mock Native Messaging/storage only; never installs packages or touches real settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const section=source.slice(source.indexOf('function sendNativeMessage('),source.indexOf('chrome.runtime.onInstalled.addListener('));
const data={specialWallets:['unchanged'],hideLightningTrade:true};
let latest='0.46.70', nativeSkip='', badge='', activeVersion='0.46.69', protocol=2, checks=0, pendingInstall=null;
const calls=[];
const chrome={
  runtime:{getManifest:()=>({version:'0.46.69'}),getURL:name=>'chrome-extension://fixture/'+name,
    sendNativeMessage:(_host,message,cb)=>{
      calls.push({...message});
      if(message.action==='check') {checks++;queueMicrotask(()=>cb({ok:true,updateAvailable:latest!==nativeSkip,skipped:latest===nativeSkip,latestVersion:latest,protocolVersion:protocol,summary:'修复布局，保留配置。'}));}
      else if(message.action==='skip'){nativeSkip=message.version;cb({ok:true});}
      else if(pendingInstall) pendingInstall.resolve=()=>cb({ok:true,updatedVersion:message.version,extensionPath:'C:/fixed/Extension'});
      else cb({ok:true,updatedVersion:message.version,extensionPath:'C:/fixed/Extension'});
    }},
  storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),set:async s=>Object.assign(data,s)}},
  action:{setBadgeText:async x=>{badge=x.text;},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
};
const ctx=vm.createContext({chrome,NATIVE_HOST:'fixture',RELEASES_URL:'https://github.com/0xuezhang985/985gmgn-helper/releases/latest',Date,AbortController,setTimeout,clearTimeout,
  fetch:async()=>({json:async()=>({version:activeVersion})})});
vm.runInContext(section,ctx);
let n=0;const pass=name=>console.log(`PASS ${++n}: ${name}`);
const [a,b]=await Promise.all([ctx.checkForUpdate(),ctx.checkForUpdate()]);
assert.equal(checks,1);assert.equal(a.updateAvailable,true);assert.equal(b.summary,a.summary);assert.equal(badge,'UP');pass('合并并发检查，提供简介和版本提示');
let s=await ctx.skipUpdateVersion('0.46.70');
assert.equal(s.skipped,true);assert.equal(s.updateAvailable,false);assert.equal(badge,'');assert.equal(nativeSkip,'0.46.70');pass('跳过同时保存到浏览器及更新器，清除提醒');
s=await ctx.checkForUpdate();assert.equal(s.skipped,true);pass('重新检查仍尊重跳过设置');
latest='0.46.71';s=await ctx.checkForUpdate();assert.equal(s.updateAvailable,true);pass('跳过旧版不屏蔽以后的新版本');
await assert.rejects(()=>ctx.skipUpdateVersion('../../bad'));await assert.rejects(()=>ctx.skipUpdateVersion('0.46.72'));pass('拒绝无效或已变化的跳过目标');
await ctx.skipUpdateVersion('');assert.equal(nativeSkip,'');assert.equal(data.updateSkippedVersion,'');pass('可恢复提醒');
activeVersion='0.46.67';const rollback=await ctx.installUpdate('0.46.67',true);
assert.equal(rollback.ok,true);assert.equal(data.updateSkippedVersion,'0.46.69');assert.equal(calls.at(-1).action,'rollback');
assert.equal(data.hideLightningTrade,true);assert.deepEqual(data.specialWallets,['unchanged']);pass('回退绑定指定版本，保留关注和 frontrun 设置');
activeVersion='0.46.69';const mismatch=await ctx.installUpdate('0.46.71');
assert.equal(mismatch.ok,false);assert.equal(mismatch.needsPathReload,true);assert.match(mismatch.error,/另一目录/);pass('浏览器目录与安装目录不同不假报成功');
activeVersion='0.46.71';pendingInstall={};const first=ctx.installUpdate('0.46.71');
await assert.rejects(()=>ctx.installUpdate('0.46.71'),/正在进行/);pendingInstall.resolve();await first;pendingInstall=null;pass('并发安装被拦截');
await assert.rejects(()=>ctx.installUpdate('../bad'));pass('无效安装目标在发给本地更新器前拒绝');
protocol=1;latest='0.46.72';nativeSkip='';await ctx.checkForUpdate();s=await ctx.skipUpdateVersion(latest);
assert.equal(s.skipped,true);assert.equal(nativeSkip,'');pass('旧更新器仍可通过浏览器设置跳过');
assert.match(source,/sender\.url\?\.split\(\/\[\?#\]\/\)\[0\] !== chrome\.runtime\.getURL\('popup.html'\)/);pass('安装和策略写入仅允许设置页发起');
console.log(`1..${n}`);
