// Exact production functions, offline DOM/Fiber fixtures. Never touches a real follow list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const take=(file,name)=>{const s=read(file),a=s.indexOf(`  function ${name}(`);assert.ok(a>=0,name);return s.slice(a,s.indexOf('\n  }',a)+4);};
const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),T='0x'+'f'.repeat(40),Sol='A'.repeat(32);
let checks=0;const pass=n=>console.log(`PASS ${++checks}: ${n}`);
const browser=await chromium.launch({headless:true});
try {
 const p=await browser.newPage({viewport:{width:1000,height:820}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.setContent('<body style="background:#121419;color:#eee"><div id="holder-detail" style="margin:100px 20px;display:flex;align-items:center;gap:5px">Holder <span id="detail" data-sentry-component="UserFollow"><svg data-icon="IconGmgnfollowwallet16px"></svg></span></div><div id="holder-list"><span id="list" data-sentry-component="UserFollow"></span></div><div id="sol-wrap"><span id="sol" data-sentry-component="UserFollow"></span></div><div id="fallback-wrap"><button><svg id="fallback" data-icon="IconGmgnfollowwallet16px"></svg></button></div><div><span id="x"><svg data-icon="IconFollow16pxRegular"></svg></span></div><div><span id="invalid" data-sentry-component="UserFollow"></span></div></body>');
 await p.addStyleTag({content:read('styles.css')});
 await p.evaluate(({A,B,T,Sol})=>{
  window.settings={enableSpecialWallet:true,specialWallets:[]};window.specialWalletMap=new Map();window.SPECIAL_COLOR_PALETTE=['#f5b83d'];window.colorPaletteEl=null;window.walletFollowButtons=new Map();window.writes=0;window.nativeClicks=0;window.failWrite=false;window.stored={};
  window.rebuildSpecialWalletSet=()=>specialWalletMap=new Map(settings.specialWallets.map(v=>[v.address,v]));window.scanSpecialWallets=()=>scanWalletFollowSettings();
  window.chrome={runtime:{},storage:{local:{get:async d=>({...d,...stored}),set:(v,cb)=>{if(failWrite)chrome.runtime.lastError={message:'quota'};else{Object.assign(stored,structuredClone(v));writes++;}cb?.();delete chrome.runtime.lastError;}}}};
  for(const [id,address]of [['detail',A],['list',B],['sol',Sol]]){const e=document.getElementById(id);e.__reactFiber$fixture={type:'span',memoizedProps:{},return:{type:function UserFollow(){},memoizedProps:{address},return:null}};e.addEventListener('click',()=>nativeClicks++);}
  document.getElementById('fallback').__reactFiber$fixture={type:'svg',memoizedProps:{},return:{type:function NativeFollow(){const filterFollowWallet=true;return filterFollowWallet;},memoizedProps:{address:B},return:null}};
  document.getElementById('invalid').__reactFiber$fixture={type:'span',memoizedProps:{},return:{type:function UserFollow(){},memoizedProps:{address:'0x123...'},return:{type:function Token(){},memoizedProps:{address:T},return:null}}};
  document.getElementById('holder-detail').addEventListener('click',()=>nativeClicks++);
 },{A,B,T,Sol});
 const bridge=read('page-bridge.js');await p.addScriptTag({content:take('page-bridge.js','setAttribute')+'\n'+bridge.slice(bridge.indexOf('  const FOLLOW_WALLET_SELECTOR'),bridge.indexOf('  function scanCards()'))});
 await p.addScriptTag({content:['SOL_ADDR_RE','EVM_ADDR_RE'].map(n=>read('content.js').match(new RegExp('  const '+n+' = .*;'))[0]).join('\n')+'\n'+['normalizeWalletAddress','normalizeSpecialColor','walletAddressFromHref','isSpecialWallet','persistSpecialWallets','closeColorPalette','openWalletFollowSettings','scanWalletFollowSettings'].map(n=>take('content.js',n)).join('\n')});
 await p.evaluate(()=>{scanWalletFollowControls();scanWalletFollowSettings();});
 assert.equal(await p.locator('.gdh-wallet-follow-settings').count(),4);
 assert.equal(await p.locator('#invalid').getAttribute('data-gdh-follow-address'),null);
 assert.equal(await p.locator('#sol').getAttribute('data-gdh-follow-address'),Sol);
 assert.equal(await p.locator('#x').getAttribute('data-gdh-follow-address'),null);
 pass('持有人详情/列表/地址类组件共享入口，支持无 sentry 图标兜底、Solana 大小写；不误认 X 关注或截断地址');
 await p.locator('#holder-detail .gdh-wallet-follow-settings').click();
 assert.equal(await p.evaluate(()=>nativeClicks),0);assert.equal(await p.evaluate(()=>writes),0);
 assert.match(await p.locator('.gdh-wallet-settings').innerText(),/Special attention/);
 assert.equal(await p.locator('[data-special=enabled]').isChecked(),false);
 await p.locator('[data-special=enabled]').check();await p.locator('[data-special=label]').fill('测试学长');await p.locator('[data-special=pin]').check();await p.locator('[data-special=persistentPin]').check();
 await p.locator('[data-special=color]').fill('#25ab90');await p.locator('.gdh-wallet-settings select').selectOption('zh');
 await p.locator('.gdh-wallet-settings').screenshot({path:'dist/wallet-follow-settings-v97.png'});
 await p.locator('.gdh-wallet-settings-save').click();
 const saved=await p.evaluate(()=>stored.specialWallets);assert.equal(saved.length,1);assert.equal(saved[0].address,A);assert.equal(saved[0].label,'测试学长');assert.equal(saved[0].color,'#25ab90');assert.ok(saved[0].pin&&saved[0].persistentPin);
 assert.equal(await p.evaluate(()=>nativeClicks),0);assert.equal(await p.locator('#holder-detail .gdh-wallet-follow-settings').innerText(),'★');
 pass('点击设置不碰原生追踪，备注/颜色/两种置顶保存到既有名单，默认英文可切中文');
 await p.locator('#holder-detail .gdh-wallet-follow-settings').click();assert.equal(await p.locator('[data-special=label]').inputValue(),'测试学长');
 await p.evaluate(()=>failWrite=true);await p.locator('[data-special=label]').fill('失败草稿');await p.locator('.gdh-wallet-settings-save').click();
 assert.equal(await p.locator('[data-special=label]').inputValue(),'失败草稿');assert.match(await p.locator('.gdh-wallet-settings-status').innerText(),/保存失败/);assert.equal(await p.evaluate(()=>settings.specialWallets[0].label),'测试学长');
 await p.evaluate(()=>failWrite=false);await p.locator('.gdh-wallet-settings-save').click();assert.equal(await p.evaluate(()=>stored.specialWallets[0].label),'失败草稿');
 pass('重新打开回填详细配置，存储失败回滚且保留草稿，可重试');
 // Recycle to B without running either scanner: clicking must synchronously read the committed Fiber.
 await p.evaluate(B=>{const e=document.getElementById('detail'),old=e.__reactFiber$fixture;const root={stateNode:{}};const nextRoot={stateNode:root.stateNode};root.stateNode.current=nextRoot;old.return.return=root;old.alternate={type:'span',memoizedProps:{},return:{type:function UserFollow(){},memoizedProps:{address:B},return:nextRoot}};},B);
 await p.locator('#holder-detail .gdh-wallet-follow-settings').click();assert.equal(await p.locator('.gdh-wallet-settings-address').innerText(),B);assert.equal(await p.locator('[data-special=enabled]').isChecked(),false);
 await p.keyboard.press('Escape');assert.equal(await p.locator('.gdh-wallet-settings').count(),0);
 await p.evaluate(()=>{scanWalletFollowControls();scanWalletFollowSettings();});
 const mutations=await p.evaluate(async()=>{let n=0;const o=new MutationObserver(a=>n+=a.length);o.observe(document.body,{subtree:true,attributes:true,childList:true});for(let i=0;i<10;i++){scanWalletFollowControls();scanWalletFollowSettings();}await Promise.resolve();o.disconnect();return n;});assert.equal(mutations,0);
 await p.evaluate(()=>{document.getElementById('list').remove();scanWalletFollowSettings();});assert.equal(await p.locator('#holder-list .gdh-wallet-follow-settings').count(),0);
 await p.evaluate(()=>{settings.enableSpecialWallet=false;scanWalletFollowSettings();});assert.equal(await p.locator('.gdh-wallet-follow-settings').count(),0);
 assert.deepEqual(errors,[]);pass('回收节点点击绑定最新钱包、Escape 关闭、稳定重扫零 DOM 改写、卸载/总开关关闭清理入口');
 console.log(`1..${checks}`);
}finally{await browser.close();}
