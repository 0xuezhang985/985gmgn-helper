// Offline browser fixtures, no real extension/profile/native host calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const browser=await chromium.launch({channel:'chrome',headless:true});let checks=0;
try {
  const page=await browser.newPage({viewport:{width:430,height:900}});
  await page.route('**/*',route=>route.fulfill({body:'',contentType:'text/plain'}));
  await page.setContent(read('popup.html').replace(/<script[^>]*src="popup.js"[^>]*><\/script>/,''));
  await page.addStyleTag({content:read('popup.css')});
  await page.addScriptTag({content:`
    window.msgs=[];window.reloads=0;window.failInstall=true;
    window.state={status:'available',currentVersion:'0.46.69',latestVersion:'0.46.70',updateAvailable:true,updaterInstalled:true,protocolVersion:2,summary:'修复布局和隐藏按钮，保留个人配置。'};
    window.chrome={runtime:{getManifest:()=>({version:'0.46.69'}),reload:()=>reloads++,sendMessage:(m,cb)=>{
      msgs.push(m);if(m.type==='skip-update'){state={...state,skipped:!!m.version,updateAvailable:!m.version,status:m.version?'skipped':'available'};cb(state);}
      else if(m.type==='update-history')cb({ok:true,versions:[{version:'0.46.67',summary:'稳定旧版，保留配置。'},{version:'0.46.66',summary:'旧版简介 <img src=x onerror=alert(1)>'}]});
      else if(m.type==='rollback-update'||m.type==='install-update')cb(failInstall?{ok:false,error:'浏览器加载的是另一目录'}:{ok:true,updatedVersion:m.version});
      else cb(state);
    }},storage:{local:{get:(defaults,cb)=>cb(typeof defaults==='object'?defaults:{}),set:(_s,cb)=>cb?.()},onChanged:{addListener:()=>{}}},tabs:{create:()=>{}}};
  `});
  await page.addScriptTag({content:read('popup.js')});
  await page.waitForFunction(()=>document.querySelector('#update-status').textContent.includes('0.46.70'));
  assert.match(await page.locator('#update-summary').innerText(),/修复布局/);
  await page.locator('#skip-update').click();assert.match(await page.locator('#update-status').innerText(),/已跳过/);
  await page.locator('#skip-update').click();assert.match(await page.locator('#update-status').innerText(),/发现/);
  console.log(`PASS ${++checks}: 显示简介、跳过与恢复提醒`);
  await page.locator('#update-history summary').click();await page.locator('#rollback-version').selectOption('0.46.66');
  assert.equal(await page.locator('#rollback-summary img').count(),0);assert.match(await page.locator('#rollback-summary').innerText(),/<img/);
  await page.locator('#rollback-version').selectOption('0.46.67');
  assert.equal(await page.locator('#rollback-update').isEnabled(),true);
  await page.locator('#rollback-update').click();assert.match(await page.locator('#update-status').innerText(),/回退未完成.*另一目录/);
  assert.equal(await page.evaluate(()=>reloads),0);console.log(`PASS ${++checks}: 历史简介纯文本显示，失败不重载或谎报成功`);
  if(process.env.GDH_TEST_SCREENSHOT) await page.locator('.update-card').screenshot({path:process.env.GDH_TEST_SCREENSHOT});
  await page.evaluate(()=>{failInstall=false;});await page.locator('#rollback-update').click();
  await page.waitForFunction(()=>reloads===1);assert.equal(await page.evaluate(()=>msgs.filter(x=>x.type==='rollback-update').at(-1).version),'0.46.67');
  console.log(`PASS ${++checks}: 一键回退使用所选版本，成功后才重载`);
  await page.evaluate(()=>{historyVersions=[];renderUpdateState({...state,protocolVersion:1});document.querySelector('#update-history').open=false;});
  await page.locator('#update-history summary').click();
  await page.waitForFunction(()=>!document.querySelector('#updater-setup').hidden);
  assert.match(await page.locator('#history-status').innerText(),/首次运行新版安装器/);console.log(`PASS ${++checks}: 旧更新器明确引导升级，不提供无效回退按钮`);
  // Real observed frontrun portal shape; simulate its inline style being replaced.
  const content=read('content.js');const start=content.indexOf('  const FRONTRUN_LIGHTNING_SELECTOR');
  const end=content.indexOf('  // ---- 价格/市值提醒',start);
  const scanStart=content.indexOf('  function scanFrontrunLightning(');const scanEnd=content.indexOf('\n  }',scanStart)+4;
  const f=await browser.newPage();await f.setContent('<div data-frontrun-portal="instant-trade" style="display:inline-flex;width:90px;margin:3px"></div><div data-frontrun-portal="cta" style="display:block">买入</div>');
  await f.addScriptTag({content:`const settings={hideLightningTrade:true};${content.slice(start,end)}\n${content.slice(scanStart,scanEnd)};scanFrontrunLightning();`});
  assert.equal(await f.locator('[data-frontrun-portal=instant-trade]').evaluate(x=>getComputedStyle(x).visibility),'hidden');
  await f.evaluate(()=>document.querySelector('[data-frontrun-portal=instant-trade]').setAttribute('style','display:inline-flex;width:90px;margin:3px'));
  await f.waitForFunction(()=>document.querySelector('[data-frontrun-portal=instant-trade]').style.visibility==='hidden');
  const mutations=await f.evaluate(async()=>{let n=0;const ob=new MutationObserver(rs=>n+=rs.length);ob.observe(document.body,{attributes:true,subtree:true});for(let i=0;i<5;i++)scanFrontrunLightning();await Promise.resolve();ob.disconnect();return n;});
  assert.equal(mutations,0);assert.equal(await f.locator('[data-frontrun-portal=cta]').getAttribute('style'),'display:block');
  await f.evaluate(()=>{settings.hideLightningTrade=false;scanFrontrunLightning();});
  assert.equal(await f.locator('[data-frontrun-portal=instant-trade]').evaluate(x=>[x.style.display,x.style.width,x.style.margin].join('|')),'inline-flex|90px|3px');
  console.log(`PASS ${++checks}: frontrun 重绘后仍隐藏、稳定扫描零改写、关闭恢复原样、不碰 CTA`);
} finally {await browser.close();}
