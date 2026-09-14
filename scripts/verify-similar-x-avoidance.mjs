import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8').replace(/\r\n/g,'\n');
const source=read('content.js');
const take=n=>{const i=source.indexOf(`  function ${n}(`);assert.ok(i>=0);return source.slice(i,source.indexOf('\n  }',i)+4);};
const browser=await chromium.launch({channel:'chrome',headless:true});
let checks=0;const pass=s=>console.log(`PASS ${++checks}: ${s}`);
try {
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  await page.setContent('<meta charset=utf-8><section id=track style="position:absolute;left:0;top:80px;width:300px;height:700px"><div data-sentry-component="TrackingBody" style="margin-top:70px">追踪</div></section><aside class=gdh-similar-token-panel><div class=gdh-similar-token__header>同名 / 相似币</div><div style="height:180px;flex-shrink:1;overflow:auto">当前币 · 相似币</div></aside>');
  await page.addStyleTag({content:read('styles.css')});
  await page.addScriptTag({content:`
    let similarTokenPanelEl=document.querySelector('aside'),similarTokenTrackerAnchor=document.querySelector('#track');
    let similarTokenUserPosition=null;
    let similarTokenPositionRaf=0,similarTokenXWatches=[],similarTokenXResize=null,similarTokenXMutation=null;
    const clearSimilarTokenPanel=()=>{};
    ${['scheduleSimilarTokenPosition','similarTokenXPreviewRects','positionSimilarTokenPanel'].map(take).join('\n')}
    const scheduleFomoFeedRowReflow=()=>{},scheduleScan=()=>{},scheduleSimilarTokenScan=()=>{};
    ${source.slice(source.indexOf('  const GDH_SELF_SELECTOR'),source.indexOf('  observer.observe(document.documentElement'))}
    observer.observe(document.documentElement,{childList:true,subtree:true});
    window.addEventListener('resize',scheduleSimilarTokenPosition);
    positionSimilarTokenPanel(similarTokenTrackerAnchor);
  `});
  const rect=()=>page.locator('aside').evaluate(e=>({top:e.getBoundingClientRect().top,left:e.getBoundingClientRect().left,bottom:e.getBoundingClientRect().bottom,hidden:getComputedStyle(e).visibility==='hidden'}));
  const baseline=await rect();assert.equal(baseline.left,308);assert.equal(baseline.top,150);pass('没有 X 预览时保持原定位');
  await page.evaluate(()=>{const x=document.createElement('div');x.id='preview';x.className='pi-tooltip-container';x.setAttribute('role','tooltip');x.style.cssText='position:fixed;left:350px;top:75px;width:302px;height:365px;background:#15202b;color:white';x.innerHTML='<div data-sentry-component="TweetContent">原生 X 预览 · Read more on X</div>';document.body.appendChild(x);});
  await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().top===448);pass('原生 X 浮窗出现后立即移至底边下方 8px');
  await page.evaluate(()=>document.querySelector('#preview').style.height='465px');
  await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().top===548);pass('图片等异步内容撑高后自动跟随');
  await page.evaluate(()=>document.querySelector('#preview').style.top='150px');
  await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().top===623);pass('原生浮窗位置变化后继续避让');
  const writes=await page.evaluate(async()=>{let n=0;const o=new MutationObserver(rs=>n+=rs.length);o.observe(similarTokenPanelEl,{attributes:true});for(let i=0;i<10;i++)positionSimilarTokenPanel(similarTokenTrackerAnchor);await Promise.resolve();o.disconnect();return n;});
  assert.equal(writes,0);pass('稳定重复定位不写 DOM，不发生反馈抖动');
  await page.evaluate(()=>document.querySelector('#preview').style.height='700px');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('aside')).visibility==='hidden');pass('下方空间不足时临时隐藏，不叠回 X 预览');
  await page.evaluate(()=>document.querySelector('#preview').remove());
  await page.waitForFunction(()=>document.querySelector('aside').getBoundingClientRect().top===150&&getComputedStyle(document.querySelector('aside')).visibility!=='hidden');pass('关闭 X 预览后自动恢复，不删浮窗或缓存');
  await page.evaluate(()=>{const x=document.createElement('div');x.id='unrelated';x.setAttribute('role','tooltip');x.style.cssText='position:fixed;left:350px;top:75px;width:300px;height:500px';x.textContent='普通工具提示';document.body.appendChild(x);positionSimilarTokenPanel(similarTokenTrackerAnchor);});
  assert.deepEqual(await rect(),baseline);pass('普通提示不触发避让');
  await page.evaluate(()=>{const x=document.querySelector('#unrelated');x.innerHTML='<div data-sentry-component="TweetContent">X</div>';x.style.left='750px';positionSimilarTokenPanel(similarTokenTrackerAnchor);});
  assert.deepEqual(await rect(),baseline);pass('横向不重叠的 X 预览不移动同名窗');
  console.log(`1..${checks}`);
} finally {await browser.close();}
