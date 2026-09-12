// Offline fixtures only: never reads or changes a user's real follow list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const source = read('content.js');
const take = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
assert.match(take('scanSpecialWallets'), /trackerStarPlacement\(card\)/);
assert.doesNotMatch(take('scanSpecialWallets'), /findCardActionContainer/);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{background:#111;color:#eee;font:12px Arial;padding:16px}
    .row{position:relative;display:flex;align-items:center;width:480px;height:44px;margin:8px 0;background:#282719}
    .maker{display:flex;align-items:center;gap:3px;width:190px;min-width:0}
    a{color:#78cf9a;text-decoration:none;white-space:nowrap}.wallet{overflow:hidden;text-overflow:ellipsis;max-width:130px}
    .token{width:150px}.mc{margin-left:auto}.wrapper{display:flex;min-width:0}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .long{max-width:125px}.name-button{background:none;border:0;color:inherit;padding:0}
  </style><main id="fixtures"></main>`);
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    const TRACKER_MAKER_CELL='[data-testid="follow-tracking-row-maker"]';
    const TRACKER_PERSON_CONTROL_SELECTOR='.gdh-star-button, .gdh-color-button, .gdh-tokenblock';
    window.starred=true;window.toggles=[];window.palettes=[];window.bubbles=0;
    const isSpecialWallet=()=>starred;const specialWalletColor=()=> '#f5b83d';
    const toggleSpecialWallet=(...args)=>toggles.push(args);
    const openColorPalette=(address)=>palettes.push(address);
    ${['trackerPersonNameText','extractRowWalletLabel','trackerStarPlacement','ensureStarButton','applySwatchColor'].map(take).join('\n')}
    window.paint=(id,address='wallet-1',label='学长')=>{
      const card=document.getElementById(id);const placement=trackerStarPlacement(card);
      if(!placement){card.querySelector('.gdh-star-button')?.remove();card.querySelector('.gdh-color-button')?.remove();return;}
      ensureStarButton(card,address,label,placement.anchor,placement.mode);
    };
    window.add=(id,body,maker=true,nick='学长')=>{
      const row=document.createElement('div');row.id=id;row.className='row';
      row.dataset.gdhStarHost='1';row.dataset.gdhTrackNick=nick;
      row.innerHTML=(maker?'<div class="maker" data-testid="follow-tracking-row-maker">'+body+'</div>':body)+'<span class="token">🟢 b...</span><span class="mc">$121K</span>';
      row.addEventListener('click',()=>bubbles++);document.getElementById('fixtures').append(row);
    };
    add('table','<a class="wallet" href="/bsc/address/wallet-1">👤 学长</a>');
    add('card','<a class="wallet" href="/bsc/address/wallet-1">👤 学长</a><span>买入</span>',false);
    document.getElementById('card').setAttribute('data-sentry-component','TrackerListItem');
    add('leaf','<span class="avatar">👤</span><span class="person">学长</span>');
    add('wrapped','<div class="wrapper long"><div class="truncate"><span>学长名字很长很长很长很长很长</span></div></div>',true,'学长名字很长很长很长很长很长');
    add('button','<button class="name-button"><span>学长</span></button>');
    add('plain-button','<button class="name-button">学长</button>');
    add('card-link','<span>学长</span><span>买入</span>',false);
    const oldCard=document.getElementById('card-link');const linkedCard=document.createElement('a');
    for(const attr of oldCard.attributes) linkedCard.setAttribute(attr.name,attr.value);
    linkedCard.href='/bsc/token/example';linkedCard.dataset.sentryComponent='TrackerListItem';
    linkedCard.replaceChildren(...oldCard.childNodes);oldCard.replaceWith(linkedCard);
    add('text','学长');
    add('missing','<span>加载中</span>');
    add('legacy','<a class="wallet" href="/bsc/address/wallet-1">👤 学长</a>');
    ensureStarButton(document.getElementById('legacy'),'wallet-1','学长',null,null);
  ` });
  const before = await page.locator('.row').evaluateAll((rows) => rows.map((row) => ({
    id: row.id, height: row.getBoundingClientRect().height, mc: row.querySelector('.mc').getBoundingClientRect().x,
  })));
  for (const id of ['table','card','leaf','wrapped','button','plain-button','card-link','text','legacy']) {
    await page.evaluate((id) => paint(id), id);
    const result = await page.locator(`#${id}`).evaluate((row) => {
      const star=row.querySelector('.gdh-star-button');const color=row.querySelector('.gdh-color-button');
      const placement=trackerStarPlacement(row);const a=placement.anchor.getBoundingClientRect();const b=star.getBoundingClientRect();
      return { count:row.querySelectorAll('.gdh-star-button').length,
        correct:placement.mode==='after'?placement.anchor.nextElementSibling===star:star.parentElement===placement.anchor,
        color:star.nextElementSibling===color,position:getComputedStyle(star).position,
        nameEnd:a.right,starStart:b.left,starEnd:b.right,rowEnd:row.getBoundingClientRect().right,
        nested:!!star.parentElement.closest('button') };
    });
    assert.equal(result.count,1,id);assert.ok(result.correct,id);assert.ok(result.color,id);
    assert.notEqual(result.position,'absolute',id);assert.ok(result.starEnd<result.rowEnd-100,id);
    assert.equal(result.nested,false,id);
    if(id!=='text') assert.ok(result.starStart>=result.nameEnd-1 && result.starStart<=result.nameEnd+16, `${id}: star after name`);
    console.log(`PASS ${++checks}: ${id} 星星及颜色按钮紧跟名字，不在市值旁`);
  }
  await page.evaluate(() => paint('missing'));
  assert.equal(await page.locator('#missing .gdh-star-button').count(),0);
  await page.evaluate(() => {
    document.querySelector('#missing .maker').innerHTML='<span>学长</span>';paint('missing');
  });
  assert.equal(await page.locator('#missing .gdh-star-button').count(),1);
  console.log(`PASS ${++checks}: 名字未加载时不乱放，加载后补上`);
  // Simulate a native name re-render while the plugin controls remain attached.
  await page.evaluate(() => {
    const name=document.querySelector('#table .wallet');const next=name.cloneNode(true);name.replaceWith(next);paint('table');
  });
  assert.equal(await page.locator('#table .wallet + .gdh-star-button + .gdh-color-button').count(),1);
  const stable = await page.evaluate(async () => {
    let writes=0;const observer=new MutationObserver(records=>writes+=records.length);
    observer.observe(document.getElementById('fixtures'),{childList:true,subtree:true});
    for(let i=0;i<5;i++) for(const row of document.querySelectorAll('.row')) paint(row.id);
    await Promise.resolve();observer.disconnect();return writes;
  });
  assert.equal(stable,0,'unchanged scans must not reparent controls');
  console.log(`PASS ${++checks}: 名字替换后重新定位，重复扫描零子节点改写`);
  const after = await page.locator('.row').evaluateAll((rows) => rows.map((row) => ({
    id:row.id,height:row.getBoundingClientRect().height,mc:row.querySelector('.mc').getBoundingClientRect().x,
  })));
  assert.deepEqual(after,before,'row height and market-cap column stay put');
  console.log(`PASS ${++checks}: 行高和市值列位置不变，长名字不裁剪星星`);
  await page.evaluate(() => {
    const link=document.querySelector('#table .wallet');link.href='/bsc/address/wallet-2';link.textContent='另一人物';
    paint('table','wallet-2','另一人物');
  });
  await page.locator('#table .gdh-star-button').click();
  await page.locator('#table .gdh-color-button').click();
  const actions=await page.evaluate(()=>({toggles,palettes,bubbles}));
  assert.deepEqual(actions,{toggles:[['wallet-2','另一人物']],palettes:['wallet-2'],bubbles:0});
  console.log(`PASS ${++checks}: 复用行使用新钱包，星星/颜色点击不触发跳转`);
  await page.evaluate(() => {starred=false;paint('table','wallet-2','另一人物');});
  assert.equal(await page.locator('#table .gdh-star-button').textContent(),'☆');
  assert.equal(await page.locator('#table .gdh-color-button').count(),0);
  assert.equal(await page.locator('#table .wallet + .gdh-star-button').count(),1);
  console.log(`PASS ${++checks}: 取消关注仍在名字后显示空星，移除颜色按钮`);
  if(process.env.GDH_TEST_SCREENSHOT) await page.screenshot({path:process.env.GDH_TEST_SCREENSHOT});
  console.log(`1..${checks}`);
} finally { await browser.close(); }
