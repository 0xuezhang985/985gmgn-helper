// Isolated browser UI only; no extension profile, real updater or user settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let n = 0;
const pass = name => console.log(`PASS ${++n}: ${name}`);
try {
  const page = await browser.newPage({ viewport: { width: 430, height: 850 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.abort());
  await page.setContent(read('popup.html').replace(/<script[^>]*src="(?:popup|buy-strategies).js"[^>]*><\/script>/g, ''));
  await page.addStyleTag({ content: read('popup.css') });
  await page.addScriptTag({ content: `
    window.mode='hang'; window.cacheMode='ok'; window.pending=[]; window.calls=[]; window.opened=0; window.reloads=0; window.writes=0;
    window.latest={status:'latest',currentVersion:'0.46.126',latestVersion:'0.46.126',updateAvailable:false,updaterInstalled:true,protocolVersion:2};
    const nativeTimeout=window.setTimeout.bind(window);
    window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms>=5000?80:ms,...args);
    window.chrome={runtime:{getManifest:()=>({version:'0.46.126'}),reload:()=>reloads++,sendMessage:(m,cb)=>{
      calls.push(m.type);
      if(m.type==='get-update-state') {
        if(cacheMode==='hang')return;
        if(cacheMode==='error'){chrome.runtime.lastError={message:'The message port closed before a response was received.'};cb();delete chrome.runtime.lastError;return;}
        cb({...latest,status:'available',latestVersion:'0.46.127',updateAvailable:true});return;
      }
      if(mode==='hang'){pending.push(cb);return;}
      if(mode==='channel-error'){chrome.runtime.lastError={message:'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'};cb();delete chrome.runtime.lastError;return;}
      if(mode==='invalid'){cb(null);return;}
      cb(mode==='missing'?{...latest,status:'updater_missing',updaterInstalled:false}:latest);
    }},storage:{local:{get:(defaults,cb)=>cb(typeof defaults==='object'?defaults:{}),set:(_s,cb)=>{writes++;cb?.();}},onChanged:{addListener:()=>{}}},tabs:{create:()=>opened++}};
  ` });
  await page.addScriptTag({ content: read('buy-strategies.js') });
  await page.addScriptTag({ content: read('popup.js') });
  await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('超时'));
  assert.equal(await page.locator('#check-update').innerText(), '重新检查');
  assert.equal(await page.locator('#check-update').isEnabled(), true);
  assert.equal(await page.evaluate(() => currentUpdateState.status), 'error');
  assert.equal(await page.evaluate(() => opened + writes + reloads), 0);
  pass('初始化检查超时后恢复按钮，不误报未安装、不自动打开网页或修改设置');

  await page.evaluate(() => { mode = 'ok'; }); await page.locator('#check-update').click();
  await page.waitForFunction(() => document.querySelector('#update-status').textContent.includes('已是最新版'));
  await page.evaluate(() => { for (const cb of pending.splice(0)) cb({ ...latest, status: 'updater_missing', updaterInstalled: false }); });
  assert.match(await page.locator('#update-status').innerText(), /已是最新版/);
  pass('手动重试成功，旧请求的迟到响应不覆盖新结果');

  await page.evaluate(() => { mode = 'channel-error'; }); await page.locator('#check-update').click();
  assert.match(await page.locator('#update-status').innerText(), /后台连接已中断/);
  assert.equal(await page.locator('#check-update').innerText(), '重新检查');
  assert.equal(await page.evaluate(() => opened), 0);
  pass('后台消息通道中断显示可重试错误，不引导用户误重装');

  for (const cacheMode of ['error', 'hang']) {
    await page.evaluate(async value => { window.cacheMode = value; mode = 'ok'; await initializeUpdateState(); }, cacheMode);
    assert.match(await page.locator('#update-status').innerText(), /已是最新版/);
    assert.equal(await page.locator('#check-update').isEnabled(), true);
  }
  pass('缓存响应丢失或中断仍发起新检查，初始化最终解锁');

  await page.evaluate(() => { mode = 'invalid'; }); await page.locator('#check-update').click();
  assert.match(await page.locator('#update-status').innerText(), /未返回有效/);
  await page.evaluate(() => { mode = 'missing'; }); await page.locator('#check-update').click();
  assert.match(await page.locator('#update-status').innerText(), /未安装/);
  assert.equal(await page.locator('#check-update').innerText(), '打开 GitHub');
  pass('无效响应不是成功，明确缺少更新器才显示安装入口');

  await page.evaluate(() => { mode = 'ok'; renderUpdateState(latest); mode = 'hang'; });
  await page.locator('#update-history summary').click();
  await page.waitForFunction(() => document.querySelector('#history-status').textContent.includes('超时'));
  assert.equal(await page.evaluate(() => historyLoading), false);
  assert.match(await page.locator('#history-status').innerText(), /重新展开可重试/);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => writes + reloads), 0);
  if (process.env.GDH_TEST_SCREENSHOT) await page.locator('.update-card').screenshot({ path: process.env.GDH_TEST_SCREENSHOT });
  pass('历史列表超时可重新展开，无页面异常或配置写入');
} finally { await browser.close(); }
console.log(`1..${n}`);
