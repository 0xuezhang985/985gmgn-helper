import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import pathModule from 'node:path';
const require=createRequire(import.meta.url), __dirname=pathModule.dirname(fileURLToPath(import.meta.url));
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'985-x-quick-test-'));const output=process.env.GDH_TEST_SCREENSHOT_DIR||dir;fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({manifest_version:3,name:'Isolated X quick-follow test',version:'1.0.0',permissions:['storage','scripting'],host_permissions:['https://x.com/*','https://985monitor.xyz/*','https://985.nz/*'],background:{service_worker:'background.js'},content_scripts:[{matches:['https://x.com/*','https://985monitor.xyz/*','https://985.nz/*'],js:['content.js'],run_at:'document_idle'}]}));
fs.writeFileSync(path.join(dir,'content.js'),'(()=>{'+fs.readFileSync(new URL('../content.js',import.meta.url),'utf8').split('// BEGIN 985 X QUICK FOLLOW UI')[1].split('// END 985 X QUICK FOLLOW UI')[0]+'})();');
fs.writeFileSync(path.join(dir,'background.js'),fs.readFileSync(new URL('../background.js',import.meta.url),'utf8').split('// BEGIN 985 X QUICK FOLLOW BACKGROUND')[1].split('// END 985 X QUICK FOLLOW BACKGROUND')[0]+`chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message?.type==='985-x-quick-presence'){noteQuickPresence(message.payload,sender).then(reply);return true;}if(['985-x-quick-state','985-x-quick-open'].includes(message?.type)){handleXQuickFollow(message,sender).then(reply).catch(()=>reply({ok:false}));return true;}});`);
let checks=0;const pass=name=>console.log(`PASS ${++checks}: ${name}`);
(async()=>{
const context=await chromium.launchPersistentContext('',{headless:true,executablePath:chromium.executablePath(),args:[`--disable-extensions-except=${dir}`,`--load-extension=${dir}`,'--host-resolver-rules=MAP * ~NOTFOUND','--js-flags=--max-old-space-size=256'],viewport:{width:700,height:800}});
context.setDefaultTimeout(12000);let requests=0;const errors=[];
try{
 await context.route('**/*',async r=>{
  const u=new URL(r.request().url());if(r.request().method()!=='GET')throw new Error('No writes expected');requests++;
  if(u.hostname==='x.com')return r.fulfill({contentType:'text/html',body:`<html><body style="background:#000;color:white;font:16px Arial"><main data-testid="primaryColumn"><div style="height:180px;background:#202329"></div><div id="profile-actions" style="display:flex;flex-wrap:wrap;justify-content:flex-end;padding:10px"><button data-testid="userActions">•••</button><button>Follow</button></div><div data-testid="UserName" style="padding:15px">Cindy<br>@${u.pathname.split('/')[1]}</div><article data-testid="tweet">A tweet by someone else</article></main></body></html>`});
  if(['985.nz','985monitor.xyz'].includes(u.hostname))return r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body>Mock 985<script>localStorage.setItem("xMonitorWalletAddress","fixture-account");localStorage.setItem("xMonitorWalletToken","fixture-token");</script></body></html>'});
  return r.abort();
 });
 const x=await context.newPage();x.on('pageerror',e=>errors.push(e.message));await x.goto('https://x.com/cydeologie');await x.waitForTimeout(800);assert.equal(await x.locator('#gdh-985-x-follow').count(),0);pass('未登录985时X主页无按钮');
 const monitor=await context.newPage();await monitor.goto('https://985.nz/');await x.bringToFront();await x.waitForSelector('#gdh-985-x-follow');pass('真实扩展自动识别985.nz登录并注入按钮');
 const before=context.pages().length;await x.evaluate(()=>document.querySelector('#gdh-985-x-follow').click());await x.waitForTimeout(150);assert.equal(context.pages().length,before);pass('网页合成点击不会打开设置窗');
 const box=await x.locator('#gdh-985-x-follow').boundingBox();const opened=context.waitForEvent('page');await x.mouse.click(box.x+box.width/2,box.y+box.height/2);const popup=await opened;
 // DNS is blocked; manually retry the newly created popup into the preinstalled mock route.
 await popup.goto('https://985.nz/?quickFollow=cydeologie');assert.ok(popup.url().includes('985.nz/?quickFollow=cydeologie'));pass('真实点击打开登录所在域名的紧凑窗口');
 await x.bringToFront();await x.waitForTimeout(200);await x.mouse.click(box.x+box.width/2,box.y+box.height/2);await x.waitForTimeout(250);assert.equal(context.pages().length,before+1);pass('再次点击复用已打开的设置窗口');
 await popup.close();await x.bringToFront();
 await x.evaluate(()=>{history.pushState({},'', '/otheruser');document.querySelector('article').textContent='update';});await x.waitForTimeout(350);assert.equal(await x.locator('#gdh-985-x-follow').count(),0);pass('SPA切换时旧主页DOM不会错订阅旧账号');
 await x.evaluate(()=>document.querySelector('[data-testid=UserName]').innerHTML='Other<br>@otheruser');await x.waitForSelector('#gdh-985-x-follow');pass('新主页身份一致后恢复按钮');
 await x.screenshot({path:path.join(output,'x-quick-follow-button.png')});
 await x.evaluate(()=>{history.pushState({},'', '/home');document.querySelector('article').textContent='home';});await x.waitForTimeout(350);assert.equal(await x.locator('#gdh-985-x-follow').count(),0);pass('首页和推文页不误插按钮');
 await monitor.evaluate(()=>{localStorage.removeItem('xMonitorWalletToken');window.dispatchEvent(new Event('focus'));});
 await x.goto('https://x.com/cydeologie');await x.waitForTimeout(600);assert.equal(await x.locator('#gdh-985-x-follow').count(),0);pass('985退出登录后按钮隐藏');
 assert.equal(errors.length,0,JSON.stringify(errors));fs.writeFileSync(path.join(output,'extension-test-results.json'),JSON.stringify({ok:true,checks,errors,requests,realUserWrites:0},null,2));
}finally{await context.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(dir).startsWith('985-x-quick-test-'));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
