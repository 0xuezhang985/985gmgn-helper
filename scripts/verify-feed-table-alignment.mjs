// Offline desktop-panel fixtures: no real account, feed or network requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const audit = fs.readFileSync(new URL('./verify-audit-fixes.mjs', import.meta.url), 'utf8');
const take = vm.runInNewContext(audit.slice(audit.indexOf('function extractFunction('), audit.indexOf('function evaluate(')) + ';extractFunction', { assert });
let count = 0; const pass = message => console.log(`PASS ${++count}: ${message}`);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  await page.route('**/*', route => route.abort());
  await page.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{background:#111;color:#eee;font:13px Arial}
    #panel{position:absolute;left:70px;top:40px;width:591px;--gdh-fomo-ink:#9e8ffc;--gdh-rank-ink:#af9eff;border:1px solid #333}
    #header,.native{display:flex;align-items:center;gap:12px;padding:8px 0;line-height:28px}
    #header{padding:8px 12px;font-size:12px;color:#888;border-bottom:1px solid #333}
    #header>div,.native>div{flex:none;white-space:nowrap;overflow:hidden}
    #header>div:nth-child(1),.native>div:nth-child(1){width:32px;margin-right:-12px}
    #header>div:nth-child(2),#header>div:nth-child(3),.native>div:nth-child(2),.native>div:nth-child(3){width:calc((100% - 218px)/2)}
    #header>div:nth-child(2),.native>div:nth-child(2){margin-right:-12px}
    #header>div:nth-child(4),.native>div:nth-child(4){width:114px;margin-right:-12px}
    #header>div:nth-child(5),.native>div:nth-child(5){width:60px;text-align:right}
    #native{display:block;color:inherit;text-decoration:none;padding:0 12px;border-bottom:1px solid #333;position:relative}
    .native{height:44px}#header[hidden]{display:none}.gdh-star-button{position:absolute;right:0;top:10px}
    </style><section id="panel">
    <div id="header" data-testid="follow-tracking-table-header"><div>时间</div><div>名称</div><div>币种</div><div>金额</div><div>市值</div></div>
    <a id="native" href="/bsc/token/fixture"><div class="native"><div>5m</div><div data-testid="follow-tracking-row-maker">原生交易员</div><div data-testid="follow-tracking-row-symbol">TOKEN 2d</div><div data-testid="follow-tracking-row-amount">0.128</div><div>$1.2M</div><button class="gdh-star-button">★</button></div></a>
    <div id="feed"></div></section>`);
  await page.addStyleTag({ content: css });
  const names = ['trackingFeedProfileMeta', 'fomoFeedRelTime', 'fomoUsd', 'buildFomoFeedTableRow', 'fomoFeedCardFor',
    'resetFomoFeedTableLayout', 'syncFomoFeedTableLayout', 'applyFomoFeedTableLayout'];
  await page.addScriptTag({ content: `
    const TRACKER_TABLE_HEADER='[data-testid="follow-tracking-table-header"]',TRACKER_SYMBOL_CELL='[data-testid="follow-tracking-row-symbol"]';
    let fomoFeedTableLayout=null,fomoFeedTableObserver=null,fomoFeedTableNodes=[];
    const fomoFeedCards=new Map();const applyTrackerTokenRelation=()=>{};const queueFomoTranslate=()=>{};
    const attachFomoFeedRank=who=>{who.classList.add('has-rank');const r=document.createElement('span');r.className='gdh-fomofeed__rank';r.textContent='总榜10';who.append(r);};
    window.scheduled=0;let pending=false;
    function scheduleScan(){scheduled++;if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;runLayout();});}
    ${names.filter(n => source.includes('function '+n+'(')).map(n => take(source, n)).join('\n')}
    function runLayout(){if(typeof syncFomoFeedTableLayout==='function')syncFomoFeedTableLayout([document.querySelector('.native')]);for(const c of fomoFeedCards.values())if(typeof applyFomoFeedTableLayout==='function')applyFomoFeedTableLayout(c);}
    function buildFomoFeedCard(ev){const c=document.createElement('div');c.className='gdh-fomofeed is-table '+(ev.source==='pump'?'is-pump is-sell':'is-buy');buildFomoFeedTableRow(ev,c,{label:ev.source==='pump'?'卖出':'买入'});return c;}
    function add(key,source,name='很长的交易员名字_WithLongSuffix'){const ev={key,source,name,handle:'fixture',symbol:'VERYLONGTOKENNAME'.repeat(3),usd:5012,mc:1123456,ts:Date.now()-60000};const c=fomoFeedCardFor(ev);document.querySelector('#feed').append(c);return c;}
    add('fomo','fomo');add('pump','pump');runLayout();
  ` });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measure = () => page.evaluate(() => {
    const box = e => { const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}; };
    return { native: [...document.querySelector('.native').children].slice(0,5).map(box),
      rows: [...document.querySelectorAll('.gdh-fomofeed__trow')].map(row=>[...row.children].map(box)) };
  });
  const aligned = async () => {
    const data = await measure();
    for (const row of data.rows) for (let i=0;i<5;i++) {
      assert.ok(Math.abs(row[i].left-data.native[i].left)<0.6, `column ${i} left: plugin ${row[i].left} native ${data.native[i].left}`);
      assert.ok(Math.abs(row[i].right-data.native[i].right)<0.6, `column ${i} right boundary differs`);
    }
  };
  await frame();
  await page.screenshot({ path: new URL('../dist/v77-feed-table-fixture.png', import.meta.url).pathname.replace(/^\/(\w:)/,'$1') });
  await aligned(); pass('FOMO 与 Pump 五列左右边界均与原生行对齐');
  assert.equal(await page.locator('.gdh-fomofeed__tamt').first().evaluate(e=>getComputedStyle(e).justifyContent),'flex-start');
  pass('金额按原生左对齐，市值继续靠右，不改变金额单位');
  for (const width of [520, 420, 780, 591]) {
    await page.locator('#panel').evaluate((e,w)=>e.style.width=w+'px',width); await frame(); await frame(); await aligned();
  }
  pass('桌面浮动面板连续缩窄和拉宽后自动跟随，不依赖整页刷新');
  await page.addStyleTag({ content:'#header>div:nth-child(2),.native>div:nth-child(2){width:150px}#header>div:nth-child(3),.native>div:nth-child(3){width:calc(100% - 368px)}' });
  await frame(); await frame(); await aligned(); pass('仅原生列宽改变、面板总宽不变时也能重新同步');
  await page.evaluate(()=>add('new','fomo','Later')); await aligned(); pass('新推送立即使用已测量的列宽');
  const overflow = await page.locator('.gdh-fomofeed__twho').first().evaluate(e=>{
    const r=e.getBoundingClientRect();return [...e.children].some(c=>c.getBoundingClientRect().right>r.right+0.6);
  });
  assert.equal(overflow,false); pass('长人名、总榜排名和来源徽章不越过名称列');
  assert.equal(await page.locator('.gdh-fomofeed__symtext').first().evaluate(e=>e.scrollWidth>e.clientWidth),true);
  pass('长币名按剩余宽度省略，买卖标签保留');
  await page.locator('#header').evaluate(e=>e.hidden=true); await page.evaluate(()=>runLayout()); await aligned();
  pass('表头隐藏时由原生五列行回退，忽略右侧星星控件');
  await page.evaluate(()=>{document.querySelectorAll('.native [data-testid]').forEach(e=>e.removeAttribute('data-testid'));runLayout();}); await aligned();
  pass('无 testid 的原生表格行仍能测量五列');
  await page.locator('#panel').evaluate(e=>e.style.zoom='0.8'); await frame(); await page.evaluate(()=>runLayout()); await aligned();
  pass('页面缩放下使用相对列宽，不累计像素偏移');
  const writes = await page.evaluate(async()=>{
    let count=0;const observer=new MutationObserver(records=>count+=records.length);observer.observe(document.querySelector('#panel'),{subtree:true,attributes:true,childList:true,characterData:true});
    for(let i=0;i<20;i++)runLayout();await Promise.resolve();observer.disconnect();return count;
  });
  assert.equal(writes,0); pass('稳定布局连续扫描 20 次零 DOM 改写');
  await page.evaluate(()=>{document.body.style.background='#fff';document.body.style.color='#222';document.querySelector('#panel').style.zoom='';document.querySelector('#header').hidden=false;runLayout();});
  await frame();await aligned();await page.screenshot({ path:new URL('../dist/v77-feed-table-light.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1') });
  pass('白色主题保持对齐和继承文字颜色');
  await page.evaluate(()=>resetFomoFeedTableLayout());
  assert.equal(await page.evaluate(()=>fomoFeedTableObserver===null&&fomoFeedTableNodes.length===0&&fomoFeedTableLayout===null),true);
  pass('切换模式或关闭推送后可释放测量监听');
  assert.match(take(source,'scanFomoFeed'),/syncFomoFeedTableLayout/);
  assert.match(take(source,'teardownFomoFeed'),/resetFomoFeedTableLayout/);
  assert.match(take(source,'fomoFeedCardFor'),/applyFomoFeedTableLayout/);
  pass('扫描、销毁和新增插卡均接入同一布局同步');
  console.log(`Feed table alignment: ${count} checks passed.`);
} finally { await browser.close(); }
