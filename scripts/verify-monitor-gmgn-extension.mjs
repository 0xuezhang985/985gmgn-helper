// Real MV3 service-worker/content-script/injection test, with every HTTP endpoint mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read=n=>fs.readFileSync(new URL('../'+n,import.meta.url),'utf8');
const source=read('content.js'),background=read('background.js');
const ui=source.slice(source.indexOf('  // BEGIN 985 GMGN FOLLOW UI'),source.indexOf('  // END 985 GMGN FOLLOW UI')).split('  // 985.nz currently')[0];
const bg=background.slice(background.indexOf('// BEGIN 985 GMGN FOLLOW BACKGROUND'),background.indexOf('// END 985 GMGN FOLLOW BACKGROUND'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'985-gmgn-bridge-test-'));
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({manifest_version:3,name:'985 isolated bridge test',version:'1.0.0',permissions:['scripting'],host_permissions:['https://gmgn.ai/*','https://985monitor.xyz/*','https://985.nz/*'],background:{service_worker:'background.js'},content_scripts:[{matches:['https://985monitor.xyz/*','https://985.nz/*'],js:['content.js'],run_at:'document_idle'}]}));
fs.writeFileSync(path.join(dir,'content.js'),`(()=>{${ui}})()`);
fs.writeFileSync(path.join(dir,'background.js'),bg+`\nchrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message?.type!=='985-gmgn-follow-add')return false;handleMonitorGmgnFollow(message,sender).then(reply);return true;});`);
const SOL='So11111111111111111111111111111111111111112';const A='0x'+'ab'.repeat(20);
let writes=[],reads=0,unauthorized=false,existing=false;let checks=0;const pass=n=>console.log(`PASS ${++checks}: ${n}`);
const row=a=>`<div class="fomo-profile-wallet-group"><div class="fomo-profile-wallet-row"><code>${a}</code><button class="fomo-profile-copy" data-fomo-wallet-copy="${a}">Copy</button></div></div>`;
const css=process.env.GDH_SITE_CSS?fs.readFileSync(process.env.GDH_SITE_CSS,'utf8'):'';
const context=await chromium.launchPersistentContext('',{headless:true,executablePath:chromium.executablePath(),args:[`--disable-extensions-except=${dir}`,`--load-extension=${dir}`,"--host-resolver-rules=MAP * ~NOTFOUND"],viewport:{width:1080,height:740}});
context.setDefaultTimeout(18000);
try{
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.hostname==='gmgn.ai'){
   if(u.pathname==='/api/v1/follow/follow_wallet_list'){
    reads++;assert.equal(req.headers().authorization,'Bearer fixture-login-only');
    return route.fulfill({status:unauthorized?401:200,contentType:'application/json',body:JSON.stringify(unauthorized?{code:40101611}:{code:0,data:{list:existing?[{following_address:SOL,name:'Keep my original note'}]:[],has_more:false,next_cursor:''}})});
   }
   if(u.pathname==='/api/v1/follow/follow_wallet'){
    writes.push(JSON.parse(req.postData()));assert.equal(req.headers().authorization,'Bearer fixture-login-only');
    return route.fulfill({contentType:'application/json',body:JSON.stringify({code:0,data:null})});
   }
   if(u.pathname==='/fixture-resource')return route.fulfill({contentType:'text/javascript',body:'void 0;'});
   return route.fulfill({contentType:'text/html',body:'<html><body>GMGN mock<script>localStorage.setItem("tgInfo",JSON.stringify({token:{access_token:"fixture-login-only"}}))</script><script src="/fixture-resource?device_id=test-device&client_id=web"></script></body></html>'});
  }
  if(['985monitor.xyz','985.nz'].includes(u.hostname))return route.fulfill({contentType:'text/html',body:`<html lang="en"><head><style>${css}</style></head><body><div class="fomo-profile-modal"><section class="fomo-profile-dialog"><header class="fomo-profile-head"><h2 data-fomo-profile-name>RC</h2></header><div class="fomo-profile-body"><h3>Wallet addresses</h3><div class="fomo-profile-wallet-grid">${row(A)}${row(SOL)}</div></div></section></div></body></html>`});
  return route.abort();
 });
 const page=await context.newPage();await page.goto('https://985monitor.xyz/');await page.waitForSelector('.gdh-monitor-follow button');
 assert.equal(writes.length,0);assert.equal(reads,0);pass('真实安装插件自动显示，挂载时不读写 GMGN API');
 await page.evaluate(()=>document.querySelectorAll('.gdh-monitor-follow button')[1].click());await page.waitForTimeout(100);
 assert.equal(context.pages().filter(p=>p.url().includes('gmgn.ai')).length,0);pass('网页伪造点击不能跨扩展调用');
 const [gmgn]=await Promise.all([context.waitForEvent('page'),page.locator('.gdh-monitor-follow button').nth(1).click()]);await gmgn.goto('https://gmgn.ai/follow?chain=sol');
 await page.waitForFunction(()=>document.querySelectorAll('[role=status]')[1].textContent.includes('opened'));
 assert.equal(writes.length,0);assert.equal(reads,0);pass('无 GMGN 页仅打开，完成登录不自动添加');
 await page.waitForTimeout(1100);
 await page.locator('.gdh-monitor-follow button').nth(1).click();
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-monitor-follow button')[1].textContent==='Added ✓');
 assert.equal(reads,1);assert.deepEqual(writes,[{chain:'sol',wallet_addresses:[SOL],remark_addresses:[[SOL,'RC','']]}]);pass('真实扩展后台注入 GMGN，正确只读核验后一次添加');
 assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('fixture-login-only')),false);assert.equal((await page.content()).includes('fixture-login-only'),false);pass('GMGN 登录信息未传入 985 页面或其 localStorage');
 await page.locator('.gdh-monitor-follow select').selectOption('arc');await page.waitForTimeout(1100);await page.locator('.gdh-monitor-follow button').first().click();
 await page.waitForFunction(()=>document.querySelector('.gdh-monitor-follow button').textContent==='Added ✓');assert.equal(writes[1].chain,'arc');pass('真实 EVM 选链写入正确');
 if(process.env.GDH_TEST_SCREENSHOT)await page.screenshot({path:process.env.GDH_TEST_SCREENSHOT});
 existing=true;await page.reload();await page.waitForSelector('.gdh-monitor-follow button');await page.waitForTimeout(1100);await page.locator('.gdh-monitor-follow button').nth(1).click();
 await page.waitForFunction(()=>document.querySelectorAll('.gdh-monitor-follow button')[1].textContent==='Following ✓');assert.equal(writes.length,2);pass('已关注钱包不写入，不覆盖备注');
 unauthorized=true;existing=false;await page.locator('.gdh-monitor-follow select').selectOption('base');await page.waitForTimeout(1100);await page.locator('.gdh-monitor-follow button').first().click();
 await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Log in'));assert.equal(writes.length,2);pass('失效登录不执行写入');
 const alias=await context.newPage();await alias.goto('https://985.nz/');await alias.waitForSelector('.gdh-monitor-follow button');assert.equal(await alias.locator('.gdh-monitor-follow').count(),2);pass('真实安装插件在 985.nz 也注入');
 console.log(JSON.stringify({ok:true,checks,realAccountWrites:0}));
}catch(error){
 console.log(JSON.stringify({reads,writes,states:await Promise.all(context.pages().map(async p=>({url:p.url(),statuses:await p.locator('[role=status]').allTextContents(),buttons:await p.locator('.gdh-monitor-follow button').allTextContents()})))}));throw error;
}finally{await context.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(dir).startsWith('985-gmgn-bridge-test-'));fs.rmSync(dir,{recursive:true,force:true});}
