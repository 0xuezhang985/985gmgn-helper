// Offline browser fixtures: native bridge -> quote cache -> panel. No user profile/account requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const take = (s, name) => { const start = s.indexOf(`function ${name}(`); assert.ok(start >= 0, name); return s.slice(start, s.indexOf('\n  }', start) + 4); };
const current = '0x1111111111111111111111111111111111111111';
const peer = '0x2222222222222222222222222222222222222222';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let tests = 0;
try {
  for (const site of ['gmgn', 'debot']) for (const mode of ['card', 'list']) {
    const source = read(site === 'gmgn' ? 'content.js' : 'debot-content.js');
    const bridge = read(site === 'gmgn' ? 'page-bridge.js' : 'debot-bridge.js');
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const row = (id) => mode === 'card' ? `<div class="native" id="${id}" data-index="${id}" data-known-size="48"></div>` : `<tr class="native" id="${id}" data-index="${id}" data-known-size="48"><td></td></tr>`;
    await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><style>
      #tracker{position:fixed;left:400px;top:50px;width:350px;height:500px;background:#16191e;color:white}.native{height:48px;display:block}
      </style><section id="tracker" data-edge-dock-panel="track"><button data-testid="follow-tracking-tab">追踪</button><div data-testid="virtuoso-scroller"><div id="rows">${mode === 'list' ? '<table><tbody>' : ''}${row('latest')}${row('older')}${mode === 'list' ? '</tbody></table>' : ''}</div></div></section></html>` }));
    const href = (address) => site === 'gmgn' ? `/base/token/${address}` : `/token/base/invite_${address}`;
    await page.goto(`https://${site}.ai${href(current)}`);
    await page.addStyleTag({ content: read(site === 'gmgn' ? 'styles.css' : 'debot-styles.css') });
    const section = site === 'gmgn'
      ? source.slice(source.indexOf('  const SIMILAR_TOKEN_META_TTL'), source.indexOf('  function requestStonkfunRwaCatalog'))
      : source.slice(source.indexOf('  // ---- DeBot 同名 / 相似币'), source.indexOf('  function syncRoute()'));
    const helpers = site === 'gmgn'
      ? ['trackingFeedNormalizedAddress', 'setBoundedMap'].map((n) => take(source, n)).join('\n')
      : ['safeText', 'validImageUrl', 'normalizeAddress', 'debotTokenRoute', 'debotTokenHref', 'debotInvitePrefix'].map((n) => take(source, n)).join('\n');
    const bridgeHelpers = (site === 'gmgn' ? ['readTrackerRecord', 'scanTrackerCard', 'setAttribute']
      : ['safeString', 'eventTimeMs', 'normalizeTrackRecord', 'findTrackRecord', 'normalizedToken', 'readTrackRecord', 'setAttr', 'scanSimilarTrackQuotes', 'navigateTokenRoute']).map((n) => take(bridge, n)).join('\n');
    await page.addScriptTag({ content: `
      window.now=1800000000000;Date.now=()=>now;
      const settings={enabled:true,enableSimilarTokenPanel:true,similarTokenCacheMinutes:5,blockedTokens:[]};
      const FOMO_NETWORK_ID={base:8453,bsc:56,sol:1399811149};
      const OWNED_SELECTOR='[data-gdh-debot-fomo-key], .gdh-debot-similar-token-panel';
      let lastSimilarQuoteScanAt=0;
      const TRACK_TAB_CELL='[data-testid="follow-tracking-tab"]';
      const trackerCards=()=>[...document.querySelectorAll('.native')];
      const currentTokenRoute=()=>({chain:'base',address:location.pathname.split('/').at(-1)});
      const gmgnApiQuery=()=>'';const scheduleScan=()=>{};const scheduleFeedLayout=()=>{};
      window.chrome={storage:{local:{set:()=>{}}}};
      ${site === 'gmgn' ? 'const isTokenBlocked=()=>false;const gdhSpaNavigate=()=>{};' : ''}
      ${helpers}
      ${bridgeHelpers}
      ${section}
      window.put=(address,mc)=>similarTokenMetaCache.set(similarTokenMetaKey('base',address),{at:now,data:{chain:'base',address,name:'The Flybook',symbol:'FLYBOOK',marketCap:mc,poolSymbol:'WETH'}});
      put('${current}',200000);put('${peer}',130000);
      window.setNative=(id,mc,ts,address='${peer}')=>{
        const el=document.getElementById(id);const link=document.createElement('a');
        link.href=${site === 'gmgn' ? "'/base/token/'+address" : "'/token/base/invite_'+address"};link.textContent='FLYBOOK';
        (el.querySelector('td')||el).replaceChildren(link);
        const record=${site === 'gmgn'
          ? "{base_address:address,base_symbol:'FLYBOOK',chain:'base',maker:'0xmaker',side:'buy',timestamp:ts/1000,price_usd:mc/1e9,base_total_supply:1e9}"
          : mode === 'card' ? "{data:{token:address,chain:'base',wallet:'0xmaker',op:'buy',unix_time:ts/1000,volume:'100',mc:String(mc)}}" : "{token:address,chain:'base',trader:'0xmaker',op:'buy',time:ts/1000,volume:100,mc}"};
        el.__reactFiber$fixture={memoizedProps:{item:record}};
      };
      window.paint=()=>{now+=250;${site === 'gmgn' ? "document.querySelectorAll('.native').forEach(el=>scanTrackerCard(el));" : "document.documentElement.setAttribute('data-gdh-debot-similar-enabled','1');scanSimilarTrackQuotes();"}scanSimilarTokenPanel();};
      setNative('latest',150000,now);setNative('older',900000,now-1000);paint();
      ${site === 'debot' ? "document.addEventListener('gdh-debot-navigate',navigateTokenRoute);" : ''}
    ` });
    const prefix = site === 'gmgn' ? '.gdh-similar-token' : '.gdh-debot-similar-token';
    assert.equal(await page.locator(`${prefix}__row`).count(), 2);
    assert.match(await page.locator(`${prefix}__row`).nth(1).innerText(), /\$150K/);
    if (site === 'debot' && mode === 'card' && process.env.GDH_TEST_SCREENSHOT) {
      await page.screenshot({ path: process.env.GDH_TEST_SCREENSHOT });
    }
    await page.evaluate(() => { setNative('latest',300000,now+1000);paint(); });
    assert.match(await page.locator(`${prefix}__row`).first().innerText(), /\$300K/);
    await page.evaluate(() => {
      const row=document.getElementById('latest');
      const old=row.__reactFiber$fixture;
      setNative('latest',350000,now+1000);
      const active=row.__reactFiber$fixture;
      const root={stateNode:{current:null}};const activeRoot={};root.stateNode.current=activeRoot;
      old.return=root;active.return=activeRoot;old.alternate=active;active.alternate=old;
      row.__reactFiber$fixture=old;paint();
    });
    assert.match(await page.locator(`${prefix}__row`).first().innerText(), /\$350K/);
    await page.evaluate((href) => { document.querySelector('#latest a').setAttribute('href',href);scanSimilarTokenPanel(); }, href(current));
    assert.match(await page.locator(`${prefix}__row[aria-current=true]`).innerText(), /\$200K/);
    await page.evaluate(() => { setNative('latest',50000,now+2000);paint(); });
    assert.match(await page.locator(`${prefix}__row`).nth(1).innerText(), /\$50K/);
    assert.match(await page.locator(`${prefix}__stats > strong`).nth(1).getAttribute('title'), /追踪面板最新市值/);
    // Metadata responses must not revert a fresher tracker quote.
    await page.evaluate((peer) => { put(peer,999999);paint(); }, peer);
    assert.match(await page.locator(`${prefix}__row`).nth(1).innerText(), /\$50K/);
    await page.evaluate(() => { setNative('latest',800000,now-2000);paint(); });
    assert.match(await page.locator(`${prefix}__row`).nth(1).innerText(), /\$50K/);
    // Same address on another chain is never allowed to overwrite this row.
    await page.evaluate((peer) => { rememberSimilarTokenTrackQuote('bsc',peer,8000000,now+9999);paint(); }, peer);
    assert.match(await page.locator(`${prefix}__row`).nth(1).innerText(), /\$50K/);
    // Quote-only updates change sort order, not the retention deadline.
    const seenAt = await page.evaluate((peer) => similarTokenRetained.get('base|'+peer).seenAt, peer);
    await page.evaluate((peer) => { document.querySelector('#rows').remove();now+=240000;rememberSimilarTokenTrackQuote('base',peer,400000,now);scanSimilarTokenPanel(); }, peer);
    assert.match(await page.locator(`${prefix}__row`).first().innerText(), /\$400K/);
    assert.equal(await page.evaluate((peer) => similarTokenRetained.get('base|'+peer).seenAt, peer), seenAt);
    assert.equal(await page.locator(`${prefix}__cached`).count(), 1);
    if (site === 'debot') {
      const origin = await page.evaluate(() => performance.timeOrigin);
      await page.locator(`${prefix}__row`).first().click();
      assert.equal(new URL(page.url()).pathname, href(peer));
      assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
      await page.evaluate(() => scanSimilarTokenPanel());
      assert.match(await page.locator(`${prefix}__row[aria-current=true]`).innerText(), /\$400K/);
    }
    await page.evaluate(() => { now+=60001;scanSimilarTokenPanel(); });
    assert.equal(await page.locator(`${prefix}-panel`).count(), 0);
    await page.evaluate(() => { settings.enableSimilarTokenPanel=false;scanSimilarTokenPanel(); });
    assert.equal(await page.evaluate(() => similarTokenTrackQuotes.size + similarTokenRetained.size), 0);
    console.log(`PASS ${++tests}: ${site} ${mode} native quote / newest trade / fall / sort / chain isolation / retention${site === 'debot' ? ' / SPA' : ''}`);
    await page.close();
  }
} finally { await browser.close(); }
