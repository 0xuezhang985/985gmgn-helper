// Isolated browser + API mocks. Never uses a real GMGN login or modifies a follow list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const content = read('content.js'), background = read('background.js');
const ui = content.slice(content.indexOf('  // BEGIN 985 GMGN FOLLOW UI'), content.indexOf('  // END 985 GMGN FOLLOW UI')).split('  // 985.nz currently')[0];
const bg = background.slice(background.indexOf('// BEGIN 985 GMGN FOLLOW BACKGROUND'), background.indexOf('// END 985 GMGN FOLLOW BACKGROUND'));
const A = '0x' + 'a1'.repeat(20), SOL = 'So11111111111111111111111111111111111111112';
let checks = 0; const pass = text => console.log(`PASS ${++checks}: ${text}`);
const fixture = (kind, address) => `<div class="fomo-profile-wallet-group"><div>${kind}</div><div class="fomo-profile-wallet-row"><code>${address}</code><button data-fomo-wallet-copy="${address}" class="fomo-profile-copy">Copy</button></div></div>`;
const html = `<html lang="en"><head></head><body><div class="fomo-profile-modal"><section class="fomo-profile-dialog" style="max-width:830px;margin:10px auto;padding:15px;background:#11151d;color:#fff"><h2 data-fomo-profile-name>RC &lt;fixture&gt;</h2><div class="fomo-profile-wallet-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${fixture('EVM', A)}${fixture('Solana', SOL)}</div></section></div><div id="feed"></div></body></html>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 const context = await browser.newContext({ viewport: { width: 1024, height: 740 } });
 await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: html }));
 const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto('https://985monitor.xyz/');
 await page.addStyleTag({ content: '.fomo-profile-wallet-row{display:flex;min-width:0;align-items:center;gap:7px}.fomo-profile-wallet-row code{min-width:0;flex:1;overflow:hidden;font:10.5px/1.45 monospace;white-space:nowrap;text-overflow:ellipsis}.fomo-profile-copy{flex:0 0 auto}' });
 assert.equal(await page.locator('.gdh-monitor-follow').count(), 0); pass('没有插件时不出现按钮或跳转入口');
 await page.evaluate(() => { window.sent = []; window.reply = { ok: true, status: 'added' }; window.chrome = { runtime: { id: 'fixture', onMessage: { addListener() {} }, sendMessage: async m => { sent.push(m); if (window.pending) return new Promise(resolve => window.finish = resolve); return reply; } } }; });
 await page.addScriptTag({ content: `(()=>{${ui}})()` });
 assert.equal(await page.locator('.gdh-monitor-follow').count(), 2);
 assert.equal(await page.locator('.gdh-monitor-follow select').count(), 1);
 assert.equal(await page.locator('.gdh-monitor-follow button').first().innerText(), 'Add to GMGN');
 assert.equal(await page.evaluate(() => sent.length), 0); pass('安装插件才增强，默认英文，仅 EVM 需要选链，初始化不发送添加');
 await page.locator('.gdh-monitor-follow button').first().click();
 assert.equal(await page.evaluate(() => sent.length), 0);
 assert.match(await page.locator('[role=status]').first().innerText(), /Select a chain/); pass('EVM 未选链禁止提交');
 await page.locator('.gdh-monitor-follow select').selectOption('arc');
 await page.evaluate(() => document.querySelector('.gdh-monitor-follow button').click());
 assert.equal(await page.evaluate(() => sent.length), 0); pass('脚本 click 不能触发写入');
 await page.locator('.gdh-monitor-follow button').first().click();
 assert.deepEqual(await page.evaluate(() => sent[0].payload), { chain: 'arc', address: A, name: 'RC <fixture>' });
 await page.waitForFunction(() => document.querySelector('.gdh-monitor-follow button').textContent === 'Added ✓');
 assert.equal(await page.locator('.gdh-monitor-follow button').first().isDisabled(), true); pass('真实点击传链、完整地址、纯文本人物名，成功后防重复');
 await page.locator('.gdh-monitor-follow select').selectOption('bsc');
 assert.equal(await page.locator('.gdh-monitor-follow button').first().isEnabled(), true); pass('同一 EVM 地址切另一条链可再次添加');
 await page.evaluate(() => { window.pending = true; });
 await page.locator('.gdh-monitor-follow button').nth(1).click();
 assert.equal(await page.locator('.gdh-monitor-follow button').nth(1).isDisabled(), true);
 assert.equal(await page.evaluate(() => sent.at(-1).payload.address), SOL);
 await page.evaluate(() => { finish({ ok: true, status: 'exists' }); pending = false; });
 await page.waitForFunction(() => document.querySelectorAll('.gdh-monitor-follow button')[1].textContent === 'Following ✓'); pass('Solana 保持大小写，处理中禁用，已关注单独展示');
 await page.evaluate(() => { document.documentElement.lang = 'zh-CN'; });
 await page.waitForFunction(() => document.querySelectorAll('.gdh-monitor-follow button')[1].textContent === '已关注 ✓'); pass('跟随网站中英文切换');
 for (const reason of ['login-required','open-gmgn','not-ready','rate-limited','list-incomplete','rejected','unavailable','unknown','busy','invalid']) {
  await page.evaluate(reason => { reply = { ok: false, reason }; }, reason);
  await page.locator('.gdh-monitor-follow button').first().click();
  await page.waitForFunction(() => !document.querySelector('.gdh-monitor-follow button').disabled);
  assert.ok((await page.locator('[role=status]').first().innerText()).length > 3);
  assert.equal(await page.locator('.gdh-monitor-follow button').first().innerText(), '添加到 GMGN');
 } pass('所有失败状态不谎报成功，均可明确重试');
 const countBefore = await page.evaluate(() => sent.length);
 await page.evaluate(() => { for (let i=0;i<100;i++) document.getElementById('feed').appendChild(document.createElement('div')); });
 await page.waitForTimeout(50);
 assert.equal(await page.locator('.gdh-monitor-follow').count(), 2); assert.equal(await page.evaluate(() => sent.length), countBefore); pass('普通推送流更新不重复插入、不触发请求');
 for (const width of [1024, 760]) {
  await page.setViewportSize({ width, height: 740 });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.gdh-monitor-follow')].every(x => x.scrollWidth <= x.clientWidth + 1)), true);
 } pass('桌面两种窗口宽度下控件无溢出');
 if (process.env.GDH_TEST_SCREENSHOT) await page.screenshot({ path: process.env.GDH_TEST_SCREENSHOT });
 await page.evaluate(() => { const modal = document.querySelector('.fomo-profile-modal'); const clone = modal.cloneNode(true); clone.querySelectorAll('.gdh-monitor-follow').forEach(x => x.remove()); modal.remove(); document.body.appendChild(clone); });
 await page.waitForFunction(() => document.querySelectorAll('.gdh-monitor-follow').length === 2); pass('关闭再打开详情正常重新注入');
 assert.deepEqual(errors, []); pass('无浏览器运行时异常');
 const alias = await context.newPage(); await alias.goto('https://985.nz/');
 await alias.evaluate(() => { window.chrome = { runtime: { id: 'fixture', onMessage: { addListener(){} }, sendMessage: async()=>({}) } }; });
 await alias.addScriptTag({ content: `(()=>{${ui}})()` }); assert.equal(await alias.locator('.gdh-monitor-follow').count(),2); pass('985.nz 别名同样支持');
 const other = await context.newPage(); await other.goto('https://evil.example/');
 await other.addScriptTag({ content: `(()=>{${ui}})()` }); assert.equal(await other.locator('.gdh-monitor-follow').count(),0); pass('非白名单域名不注入');
 await context.close();
} finally { await browser.close(); }

function sandbox(options = {}) {
 const calls = [], state = { token: 'test-token', cooldown: 0, ...options };
 const env = { URL, URLSearchParams, AbortSignal, Date: { now: () => 100000 + state.cooldown }, Set, Map,
  location: { origin: 'https://gmgn.ai' }, window: {}, localStorage: { getItem: () => JSON.stringify({ token: { access_token: state.token } }) },
  performance: { getEntriesByType: () => state.noParams ? [] : [{ name: 'https://gmgn.ai/api/v1/x?device_id=fixture&client_id=web&secret=notforwarded&chain=other' }] },
  fetch: async (url, init) => { calls.push({ url, init }); if (state.throwFetch) throw Error('secret-value');
   if (state.switchAccount) state.token = 'other-account';
   const body = url.includes('follow_wallet_list?') ? (state.listBody || { code: 0, data: { list: state.list || [], has_more: state.hasMore || false } }) : (state.addBody || { code: 0, data: null });
   return { status: state.httpStatus || 200, ok: !state.httpStatus || state.httpStatus === 200, json: async () => { if (state.badJson) throw Error('bad'); return body; } };
  },
  chrome: { runtime: { id: 'own-extension' }, tabs: { query: async () => state.tabs || [{ id: 7, windowId: 3, incognito: false }], create: async o => calls.push({ create: o }) }, scripting: { executeScript: async o => { calls.push({ execute: { tabId: o.target.tabId, payload: o.args[0] } }); if (state.pause) await new Promise(r => state.resume = r); return [{ result: state.injectResult || { ok: true, status: 'added' } }]; } } },
 };
 env.window.top = env.window; vm.createContext(env); vm.runInContext(bg, env);
 return { env, state, calls };
}
const plain = x => JSON.parse(JSON.stringify(x));
const payload = { chain: 'bsc', address: A, name: 'RC' };
const sender = { id: 'own-extension', frameId: 0, url: 'https://985monitor.xyz/', tab: { id: 2, url: 'https://985monitor.xyz/', windowId: 3, incognito: false } };
{
 const { env } = sandbox();
 for (const p of [null, {}, { ...payload, chain: 'fake' }, { ...payload, address: '<script>' }, { ...payload, chain: 'sol' }, { ...payload, name: {} }]) assert.equal(env.normalizeMonitorFollow(p), null);
 assert.deepEqual(plain(env.normalizeMonitorFollow({ ...payload, address: '0x'+ 'AB'.repeat(20), name: 'z'.repeat(50) })), { chain: 'bsc', address: '0x'+'ab'.repeat(20), name: 'z'.repeat(32) });
 assert.equal(env.normalizeMonitorFollow({ chain:'sol',address:SOL }).address,SOL); pass('后台地址／链／备注严格校验，Solana 不转小写');
}
for (const bad of [{ ...sender, id:'other' }, { ...sender, frameId: 1 }, { ...sender, url: 'https://evil.example' }, { ...sender, url: 'https://985monitor.xyz.evil.example' }, { ...sender, tab: { ...sender.tab, url: 'https://other.example' } }, { ...sender, tab: undefined }]) {
 const { env, calls } = sandbox(); assert.equal((await env.handleMonitorGmgnFollow({payload},bad)).ok,false); assert.equal(calls.length,0);
} pass('拒绝其他扩展、嵌套框架、伪造域名和不匹配标签页');
{
 const {env,calls}=sandbox({tabs:[]}); assert.equal((await env.handleMonitorGmgnFollow({payload},sender)).reason,'open-gmgn');
 assert.equal(calls.length,1); assert.equal(calls[0].create.url,'https://gmgn.ai/follow?chain=bsc'); pass('无 GMGN 页只打开登录入口，不排队自动关注');
}
{
 const {env,calls}=sandbox({tabs:[{id:8,incognito:true,windowId:3},{id:7,incognito:false,windowId:5},{id:9,incognito:false,windowId:3}]});
 assert.equal((await env.handleMonitorGmgnFollow({payload},sender)).ok,true); assert.equal(calls[0].execute.tabId,9); pass('不串用隐身登录态，优先同窗口 GMGN');
}
{
 const {env,state,calls}=sandbox({pause:true});const first=env.handleMonitorGmgnFollow({payload},sender);await new Promise(r=>setTimeout(r,0));
 assert.equal((await env.handleMonitorGmgnFollow({payload},sender)).reason,'busy');state.resume();await first;assert.equal(calls.length,1); pass('跨 985 标签页并发合并，禁止重复写入');
}
for (const options of [{token:''},{noParams:true},{list:[{following_address:A.toUpperCase()}]},{list:[{address:A}]},{hasMore:true},{listBody:{code:0,data:{}}},{switchAccount:true},{httpStatus:401},{httpStatus:429},{badJson:true},{throwFetch:true}]) {
 const {env,calls}=sandbox(options); const r=await env.addMonitorWalletInGmgn(payload);
 assert.ok(!r.ok || r.status==='exists'); assert.ok(calls.length<=1); assert.ok(!JSON.stringify(r).includes('test-token')); assert.ok(!JSON.stringify(r).includes('secret-value'));
} pass('登录失效、名单不完整、已关注、切账号和读取失败均不执行添加');
{
 const {env,calls}=sandbox(); const r=await env.addMonitorWalletInGmgn(payload); assert.equal(r.status,'added'); assert.equal(calls.length,2);
 const [read,write]=calls;assert.ok(read.url.includes('follow_wallet_list?'));assert.ok(write.url.includes('follow_wallet?'));
 assert.deepEqual(JSON.parse(write.init.body),{chain:'bsc',wallet_addresses:[A],remark_addresses:[[A,'RC','']]});
 assert.ok(!write.url.includes('secret'));assert.ok(!write.url.includes('chain=other'));assert.equal(write.init.headers.Authorization,'Bearer test-token');
 assert.equal(JSON.stringify(r),' {"ok":true,"status":"added"}'.trim());pass('新关注才写备注，鉴权只发送 GMGN，回传只有状态');
}
{
 const {env,calls}=sandbox({addBody:{code:42,message:'secret upstream response'}});assert.equal((await env.addMonitorWalletInGmgn(payload)).reason,'rejected');assert.equal(calls.length,2); pass('上游业务失败不被 HTTP 200 冒充成功，原文不外传');
}
{
 const {env,state,calls}=sandbox({injectResult:{ok:false,reason:'rate-limited',token:'secret'}});assert.equal((await env.handleMonitorGmgnFollow({payload},sender)).reason,'rate-limited');
 state.cooldown=299999;
 assert.equal((await env.handleMonitorGmgnFollow({payload},sender)).reason,'busy');pass('429 后至少五分钟退避，不自动重试');
 assert.equal(calls.length,1);
}
const manifest=JSON.parse(read('manifest.json'));assert.ok(manifest.host_permissions.includes('https://985.nz/*'));assert.ok(!manifest.externally_connectable);assert.ok(!content.includes('postMessage({ type: \'985-gmgn-follow-add\''));pass('别名权限正确，没有外部网页消息写入接口');
console.log(JSON.stringify({ok:true,checks}));
