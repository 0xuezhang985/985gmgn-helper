// 离线回归：追踪流方向着色、推送声音提醒、徽章分项开关。
// 不连任何网络，不读用户真实设置；音频用假 AudioContext 记账，不出声。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = n => fs.readFileSync(path.join(root, n), 'utf8').replace(/\r\n/g, '\n');
const source = read('content.js');

const fn = name => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
// 常量表按原样搬过来，避免测试里再抄一份、抄到和实现对不上。
const block = (decl, close) => {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `missing ${decl}`);
  return source.slice(start, source.indexOf(`\n  ${close}`, start) + close.length + 3);
};
const line = (decl) => {
  const start = source.indexOf(decl);
  assert.ok(start >= 0, `missing ${decl}`);
  return source.slice(start, source.indexOf('\n', start));
};

let checks = 0;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.route('**/*', r => r.abort());
  await page.setContent('<!doctype html><html><body style="background:#111"></body></html>');
  await page.addStyleTag({ content: read('styles.css') });
  await page.addScriptTag({ content: `
    window.played = [];
    // 假 AudioContext：只记录被排进去的振荡器，不真的出声。
    class FakeOsc {
      constructor(log) { this.log = log; this.frequency = { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
      connect() {} disconnect() {}
      start(at) { this.log.push({ note: this.frequency.value, at, wave: this.type }); }
      stop() {}
    }
    class FakeGain { constructor() { this.gain = { peaks: [], setValueAtTime: (v) => this.gain.peaks.push(v), linearRampToValueAtTime: (v) => this.gain.peaks.push(v), exponentialRampToValueAtTime: () => {} }; } connect() {} disconnect() {} }
    window.fakeAudio = { state: 'running', currentTime: 0, createOscillator() { return new FakeOsc(window.played); }, createGain() { return new FakeGain(); }, destination: {} };

    const DEFAULTS = { feedSound: { on: false, kind: 'beep', volume: 70 } };
    let settings = { feedSound: { on: false, kind: 'beep', volume: 70 }, feedSoundPeople: {}, enableTrackerSideColor: true,
      enableFlapTaxBadge: true, enableGeniusBadge: true };
    const flapInfoCache = new Map();
    const feedSoundSince = 1000;
    let feedAudio = window.fakeAudio;
    let feedSoundBusyUntil = 0;
    function trackerCards() { return [...document.querySelectorAll('[data-row]')]; }
    ${line('  const TRACK_BUY_RE')}
    ${line('  const TRACK_SELL_RE')}
    ${block('  const FEED_SOUND_PATTERNS = {', '};')}
    ${['chipText', 'trackerRowSide', 'applyTrackerSideColor', 'scanTrackerSideColors',
      'outermostSameText', 'keepColorNodes', 'markKeepColorNodes', 'clearKeepColorNodes',
      'playFeedSound', 'feedSoundPersonKey', 'feedSoundFor', 'announceFeedEvent',
      'flapBadgeEnabled'].map(fn).join('\n')}
    Object.assign(window, { settings, DEFAULTS, flapInfoCache, trackerRowSide, applyTrackerSideColor,
      scanTrackerSideColors, playFeedSound, feedSoundFor, feedSoundPersonKey, announceFeedEvent, flapBadgeEnabled,
      resetBusy: () => { feedSoundBusyUntil = 0; window.fakeAudio.currentTime = 0; },
      setAudio: (v) => { feedAudio = v; } });
  ` });

  // ---- 方向判定 ----
  const sides = await page.evaluate(() => {
    const make = (html, attrs = {}) => {
      const el = document.createElement('a');
      el.setAttribute('data-row', '1');
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      el.innerHTML = html;
      document.body.appendChild(el);
      return el;
    };
    return {
      fromBridge: trackerRowSide(make('<span>清仓</span>', { 'data-gdh-track-side': 'buy' })),
      openPosition: trackerRowSide(make('<span>建仓</span>')),
      addPosition: trackerRowSide(make('<span>加仓</span>')),
      trim: trackerRowSide(make('<span>减仓 +743%</span>')),
      close: trackerRowSide(make('<span>清仓 -2%</span>')),
      transferIn: trackerRowSide(make('<span>转入</span>')),
      thesis: trackerRowSide(make('<span>观点</span>')),
      // 币名叫「建仓」时不能被当成动作词：只认叶子节点里的完整动作词。
      tokenNamedLikeAction: trackerRowSide(make('<span><b>建仓币</b></span><span>观点</span>')),
      ownBuyCard: (() => { const el = make(''); el.className = 'gdh-fomofeed is-buy'; return trackerRowSide(el); })(),
      ownSellCard: (() => { const el = make(''); el.className = 'gdh-fomofeed is-sell'; return trackerRowSide(el); })(),
      ownTransferCard: (() => { const el = make(''); el.className = 'gdh-fomofeed is-transfer'; return trackerRowSide(el); })(),
      ownThesisCard: (() => { const el = make(''); el.className = 'gdh-fomofeed is-thesis'; return trackerRowSide(el); })(),
    };
  });
  assert.deepEqual(sides, {
    fromBridge: 'buy', openPosition: 'buy', addPosition: 'buy', trim: 'sell', close: 'sell',
    transferIn: 'buy', thesis: '', tokenNamedLikeAction: '',
    ownBuyCard: 'buy', ownSellCard: 'sell', ownTransferCard: 'buy', ownThesisCard: '',
  }, 'direction comes from the bridge first, then the leaf action word');
  checks++;

  // ---- 开关：关掉后属性清空，页面恢复原样 ----
  const toggled = await page.evaluate(() => {
    scanTrackerSideColors();
    const on = document.querySelectorAll('[data-gdh-side]').length;
    settings.enableTrackerSideColor = false;
    scanTrackerSideColors();
    const off = document.querySelectorAll('[data-gdh-side]').length;
    settings.enableTrackerSideColor = true;
    scanTrackerSideColors();
    return { on, off, back: document.querySelectorAll('[data-gdh-side]').length };
  });
  assert.equal(toggled.off, 0, 'turning the switch off leaves no attribute behind');
  assert.ok(toggled.on > 0 && toggled.on === toggled.back);
  checks++;

  // ---- 真实 CSS：整行变色，但币名 / 市值 / 底池名保持原色 ----
  // 行结构照搬真实 GMGN 追踪卡：颜色往往不写在文字那个节点上。
  // 市值的灰色来自外层容器，底池名的蓝色来自 quote-token-tag 本体，
  // 只排除最内层会被外层的 color:inherit 带走 —— 0.46.106 就是这么错的。
  const painted = await page.evaluate(() => {
    document.body.innerHTML = '';
    const row = document.createElement('a');
    row.setAttribute('data-row', '1');
    row.setAttribute('data-gdh-track-side', 'buy');
    row.innerHTML = '<div data-testid="follow-tracking-row-maker"><span id="who" style="color:#f8b951">奶牛新号</span></div>'
      + '<span id="act" data-testid="follow-tracking-row-side" style="color:#f5f5f5">建仓</span>'
      + '<div data-testid="follow-tracking-row-amount"><div id="amt" style="color:#de5759">0.325</div></div>'
      + '<div data-testid="follow-tracking-row-symbol">'
      + '<span id="sym" style="color:#f5f5f5">2DEEP</span>'
      + '<div id="age" style="color:#46b87d">26m</div>'
      + '<span id="quote" data-testid="quote-token-tag" style="color:#4ea7fa"><span id="quotetext">USDG</span></span>'
      + '</div>'
      + '<div id="mcblock" style="color:#808080"><div><span id="mclabel">MC:<span id="mcvalue" style="color:#f5f5f5">$4.5M</span></span></div></div>'
      + '<button id="bell" class="gdh-feed-sound-button" style="color:#f5b83d">\u{1F514}</button>';
    document.body.appendChild(row);
    scanTrackerSideColors();
    const color = id => getComputedStyle(document.getElementById(id)).color;
    const snap = () => ({ who: color('who'), act: color('act'), amt: color('amt'), age: color('age'),
      sym: color('sym'), quote: color('quote'), quotetext: color('quotetext'),
      mclabel: color('mclabel'), mcvalue: color('mcvalue'), bell: color('bell') });
    const buy = snap();
    row.setAttribute('data-gdh-track-side', 'sell');
    delete row.dataset.gdhSide;
    scanTrackerSideColors();
    const sell = snap();
    // 关掉开关要连保色标记一起清干净
    settings.enableTrackerSideColor = false;
    scanTrackerSideColors();
    const off = { ...snap(), marks: document.querySelectorAll('[data-gdh-keep-color]').length };
    settings.enableTrackerSideColor = true;
    scanTrackerSideColors();
    return { buy, sell, off };
  });
  const GREEN = 'rgb(34, 197, 94)', RED = 'rgb(248, 113, 113)';
  assert.deepEqual(painted.buy, {
    who: GREEN, act: GREEN, amt: GREEN, age: GREEN,
    sym: 'rgb(245, 245, 245)', quote: 'rgb(78, 167, 250)', quotetext: 'rgb(78, 167, 250)',
    mclabel: 'rgb(128, 128, 128)', mcvalue: 'rgb(245, 245, 245)', bell: 'rgb(245, 184, 61)',
  }, 'buys go green except token name, pool name, market cap and our own controls');
  assert.deepEqual(painted.sell, {
    who: RED, act: RED, amt: RED, age: RED,
    sym: 'rgb(245, 245, 245)', quote: 'rgb(78, 167, 250)', quotetext: 'rgb(78, 167, 250)',
    mclabel: 'rgb(128, 128, 128)', mcvalue: 'rgb(245, 245, 245)', bell: 'rgb(245, 184, 61)',
  }, 'sells go red under the same exceptions');
  assert.deepEqual(painted.off, {
    who: 'rgb(248, 185, 81)', act: 'rgb(245, 245, 245)', amt: 'rgb(222, 87, 89)', age: 'rgb(70, 184, 125)',
    sym: 'rgb(245, 245, 245)', quote: 'rgb(78, 167, 250)', quotetext: 'rgb(78, 167, 250)',
    mclabel: 'rgb(128, 128, 128)', mcvalue: 'rgb(245, 245, 245)', bell: 'rgb(245, 184, 61)', marks: 0,
  }, 'turning the switch off restores every original colour and leaves no marks');
  checks++;

  // ---- 声音：全局 / 个人的取舍 ----
  const chosen = await page.evaluate(() => {
    const fomo = { source: 'fomo', handle: 'slingoor', ts: 2000 };
    const pump = { source: 'pump', pumpWallet: 'Abc123', ts: 2000 };
    const out = {};
    out.keys = [feedSoundPersonKey(fomo), feedSoundPersonKey(pump)];
    settings.feedSound = { on: false, kind: 'beep', volume: 70 };
    settings.feedSoundPeople = {};
    out.allMuted = feedSoundFor(fomo);
    settings.feedSoundPeople = { 'fomo:slingoor': 'bell' };
    out.personalOnWhileGlobalOff = feedSoundFor(fomo);
    out.otherPersonStillSilent = feedSoundFor({ source: 'fomo', handle: 'someone', ts: 2000 });
    settings.feedSound = { on: true, kind: 'chime', volume: 70 };
    out.globalOn = feedSoundFor({ source: 'fomo', handle: 'someone', ts: 2000 });
    out.personalWins = feedSoundFor(fomo);
    settings.feedSoundPeople = { 'fomo:slingoor': 'off' };
    out.personalMuteWins = feedSoundFor(fomo);
    settings.feedSoundPeople = { 'pump:Abc123': 'radar' };
    out.pumpByWallet = feedSoundFor(pump);
    return out;
  });
  assert.deepEqual(chosen, {
    keys: ['fomo:slingoor', 'pump:Abc123'],
    allMuted: '', personalOnWhileGlobalOff: 'bell', otherPersonStillSilent: '',
    globalOn: 'chime', personalWins: 'bell', personalMuteWins: '', pumpByWallet: 'radar',
  }, 'per-person setting beats the global one in both directions');
  checks++;

  // ---- 声音：首屏历史不出声、同一秒不叠响、音量 0 静音 ----
  const played = await page.evaluate(() => {
    settings.feedSound = { on: true, kind: 'rise', volume: 70 };
    settings.feedSoundPeople = {};
    const ev = ts => ({ source: 'fomo', handle: 'x', ts });
    const out = {};
    window.resetBusy(); window.played.length = 0;
    out.old = announceFeedEvent(ev(999));          // 早于本次加载
    out.atBoundary = announceFeedEvent(ev(1000));  // 正好等于加载时刻也算旧
    out.fresh = announceFeedEvent(ev(2000));
    out.notes = window.played.length;
    out.immediateRepeat = announceFeedEvent(ev(2001));
    window.fakeAudio.currentTime = 99;
    out.afterCooldown = announceFeedEvent(ev(2002));
    window.resetBusy(); window.played.length = 0;
    settings.feedSound = { on: true, kind: 'rise', volume: 0 };
    out.zeroVolume = announceFeedEvent(ev(3000));
    settings.feedSound = { on: true, kind: 'nope', volume: 70 };
    out.unknownKind = announceFeedEvent(ev(3001));
    window.setAudio({ ...window.fakeAudio, state: 'suspended' });
    settings.feedSound = { on: true, kind: 'rise', volume: 70 };
    out.locked = announceFeedEvent(ev(3002));
    window.setAudio(window.fakeAudio);
    return out;
  });
  assert.deepEqual(played, {
    old: false, atBoundary: false, fresh: true, notes: 3,
    immediateRepeat: false, afterCooldown: true,
    zeroVolume: false, unknownKind: false, locked: false,
  }, 'only genuinely new events ring, at most once per burst');
  checks++;

  // ---- 徽章分项开关 ----
  const badges = await page.evaluate(() => {
    flapInfoCache.set('flapcoin', { ok: true, kind: 'flap' });
    flapInfoCache.set('geniuscoin', { ok: true, kind: 'genius' });
    flapInfoCache.set('broken', { ok: false, reason: 'rpc-failed' });
    const read = () => ['flapcoin', 'geniuscoin', 'broken'].map(flapBadgeEnabled);
    const out = { both: read() };
    settings.enableGeniusBadge = false;
    out.geniusOff = read();
    settings.enableGeniusBadge = true;
    settings.enableFlapTaxBadge = false;
    out.flapOff = read();
    settings.enableFlapTaxBadge = true;
    return out;
  });
  assert.deepEqual(badges, {
    both: [true, true, false],
    geniusOff: [true, false, false],
    flapOff: [false, true, false],
  }, 'each badge kind has its own switch and failures are still hidden');
  checks++;

  assert.equal(await page.evaluate(() => window.__errors?.length || 0), 0);

  // ---- 设置页：新开关真的绑上了，读得回来也存得进去 ----
  const popup = await browser.newPage({ viewport: { width: 430, height: 900 } });
  const popupErrors = [];
  popup.on('pageerror', (error) => popupErrors.push(error.message));
  await popup.route('**/*', route => route.fulfill({ body: '', contentType: 'text/plain' }));
  await popup.setContent(read('popup.html')
    .replace(/<script[^>]*src="(?:popup|buy-strategies).js"[^>]*><\/script>/g, ''));
  await popup.addScriptTag({ content: `
    window.saved = null;
    window.stored = { enableGeniusBadge: false, enableTrackerSideColor: false,
      feedSound: { on: true, kind: 'radar', volume: 100 } };
    window.chrome = { runtime: { getManifest: () => ({ version: '0.0.0' }), sendMessage: (m, cb) => cb?.({}) },
      storage: { local: {
        get: (defaults, cb) => cb({ ...(typeof defaults === 'object' ? defaults : {}), ...window.stored }),
        set: (values, cb) => { window.saved = values; cb?.(); } },
        onChanged: { addListener: () => {} } }, tabs: { create: () => {} }, permissions: { request: (_, cb) => cb(true) } };
  ` });
  await popup.addScriptTag({ content: read('buy-strategies.js') });
  await popup.addScriptTag({ content: read('popup.js') });
  const loaded = await popup.evaluate(() => ({
    genius: document.querySelector('#enable-genius-badge').checked,
    flapTax: document.querySelector('#enable-flap-tax-badge').checked,
    rhPool: document.querySelector('#enable-rh-pool-badge').checked,
    rhDividend: document.querySelector('#enable-rh-dividend-badge').checked,
    fomoShare: document.querySelector('#enable-fomo-share-badge').checked,
    nativePool: document.querySelector('#enable-native-pool-badge').checked,
    sideColor: document.querySelector('#enable-tracker-side-color').checked,
    soundOn: document.querySelector('#feed-sound-on').checked,
    soundKind: document.querySelector('#feed-sound-kind').value,
    soundVolume: document.querySelector('#feed-sound-volume').value,
  }));
  assert.deepEqual(loaded, {
    genius: false, flapTax: true, rhPool: true, rhDividend: true, fomoShare: true, nativePool: true,
    sideColor: false, soundOn: true, soundKind: 'radar', soundVolume: '100',
  }, 'stored values reach every new control');
  checks++;

  const saved = await popup.evaluate(async () => {
    document.querySelector('#enable-genius-badge').checked = true;
    document.querySelector('#enable-rh-dividend-badge').checked = false;
    document.querySelector('#enable-tracker-side-color').checked = true;
    document.querySelector('#feed-sound-on').checked = false;
    document.querySelector('#feed-sound-kind').value = 'chime';
    document.querySelector('#feed-sound-volume').value = '30';
    document.querySelector('#save').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const s = window.saved || {};
    return { genius: s.enableGeniusBadge, rhDividend: s.enableRhDividendBadge,
      sideColor: s.enableTrackerSideColor, sound: s.feedSound };
  });
  assert.deepEqual(saved, {
    genius: true, rhDividend: false, sideColor: true,
    sound: { on: false, kind: 'chime', volume: 30 },
  }, 'every new control is written back on save');
  checks++;
  assert.deepEqual(popupErrors, [], 'settings page raises no errors');
} finally {
  await browser.close();
}
console.log(`PASS ${checks} feed extras checks (offline, no audio output)`);
