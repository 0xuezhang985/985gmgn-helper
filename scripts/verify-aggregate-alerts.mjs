// Pure engine + offline production UI. No real wallet data, requests or audible user-tab tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = read('aggregate-monitor.js'), module = { exports: {} };
vm.runInNewContext(code, { module, URL });
const { create, alertSettings, alertLevel, createAlerts, parseAlertLedger, createAlertSound, SOUND_CHOICES } = module.exports;
const plain = x => JSON.parse(JSON.stringify(x));
let n = 0; const pass = text => console.log(`PASS ${++n}: ${text}`);
const NOW = 1789500000000, A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), T = '0x' + '1'.repeat(40);
const buy = (patch = {}) => ({ source: 'gmgn', chain: 'bsc', wallet: A, addr: T, type: 'buy', ts: NOW, tx: '0x111', usd: 1100, ...patch });
const config = alertSettings({ ...alertSettings(), enabled: true });
const snapshot = (e, now = NOW, opts = {}) => e.snapshot({ windowMs: 60000, includeBuyKeys: true, minBuyers: 1, ...opts }, now).rows;
assert.equal(alertSettings().enabled, false);
for (const patch of [{ seconds: 0 }, { seconds: 3601 }, { seconds: 1.1 }, { levels: [] },
  { levels: config.levels.map(l => ({ ...l, enabled: false })) }, { levels: config.levels.map(l => ({ ...l, usd: 0, buyers: 0 })) },
  { levels: config.levels.map(l => ({ ...l, buyers: 1.5 })) }]) assert.equal(alertSettings({ ...config, ...patch }), null);
assert.equal(alertSettings({ ...config, seconds: 1, cooldown: 3600 }).seconds, 1);
assert.equal(Object.hasOwn(alertSettings({ ...config, cooldown: 30 }), 'cooldown'), false);
pass('默认关闭，秒数和三档门槛严格校验；旧冷却字段被忽略，不再循环提醒');
const legacy = { ...plain(config) }; delete legacy.volume; legacy.levels.forEach(l => delete l.sound);
assert.deepEqual(plain(alertSettings(legacy)), plain(config)); assert.equal(config.volume, 80);
assert.equal(SOUND_CHOICES.length, 6);
for (const volume of [-1, 101, 10.5, Infinity, NaN]) assert.equal(alertSettings({ ...config, volume }), null);
for (const name of ['', 'unknown', '__proto__', 'constructor']) assert.equal(alertSettings({ ...config, levels: config.levels.map(l => ({ ...l, sound: name })) }), null);
assert.equal(alertSettings({ ...config, volume: 0 }).volume, 0);
pass('旧设置保留阈值和开关，缺失字段兼容 80% 清脆提示；音量与六种音色严格校验');
assert.equal(alertLevel({ buyUsd: 1000, buyerCount: 1 }, config), 0);
assert.equal(alertLevel({ buyUsd: 1000.01, buyerCount: 1 }, config), 1);
assert.equal(alertLevel({ buyUsd: 0, buyerCount: 5 }, config), 2);
assert.equal(alertLevel({ buyUsd: 10001, buyerCount: 1 }, config), 3);
assert.equal(alertLevel({ buyUsd: 0, buyerCount: 8 }, config), 3);
assert.equal(alertLevel({ buyUsd: 10001, buyerCount: 1 }, { ...config, levels: config.levels.map(l => ({ ...l, usd: 0 })) }), 0);
pass('USD 严格大于、人数大于等于；OR 条件、零值忽略、最高档优先');
{
  const e = create(); e.ingest([buy(), buy({ tx: '0x222', ts: NOW - 60000 }), buy({ tx: '0x333', ts: NOW - 60001 }),
    buy({ tx: '0x444', ts: NOW + 1000 }), buy({ tx: '0x555', type: 'sell', wallet: B })], NOW);
  assert.equal(snapshot(e)[0].buyUsd, 2200);
  assert.equal(snapshot(e, NOW, { after: NOW - 1 })[0].buyUsd, 1100);
  assert.equal(snapshot(e, NOW, { after: NOW }).length, 0);
  assert.equal(snapshot(e, NOW, { windowMs: 1000 })[0].buyCount, 1);
  assert.equal(snapshot(e, NOW + 61001).length, 0);
  pass('精确秒级窗口包含下界；启动前、未来、过期与卖出事件不凑数');
}
{
  const e = create(), alarm = createAlerts(); e.ingest([buy()], NOW);
  const initial = alarm.evaluate(snapshot(e), config, NOW)[0]; assert.equal(initial.level, 1); alarm.remember(initial);
  for (let i = 1; i <= 35; i++) assert.equal(alarm.evaluate(snapshot(e, NOW + i * 1000), config, NOW + i * 1000).length, 0);
  e.ingest([buy({ tx: '0x222', ts: NOW + 36000, usd: 100 })], NOW + 36000);
  assert.equal(alarm.evaluate(snapshot(e, NOW + 36000), config, NOW + 36000).length, 0);
  e.ingest([buy({ tx: '0x333', wallet: B, ts: NOW + 37000, usd: 100 })], NOW + 37000);
  assert.equal(alarm.evaluate(snapshot(e, NOW + 37000), config, NOW + 37000).length, 0);
  e.ingest([buy({ tx: '0x444', ts: NOW + 38000, usd: 10000 })], NOW + 38000);
  const high = alarm.evaluate(snapshot(e, NOW + 38000), config, NOW + 38000)[0]; assert.equal(high.level, 3); alarm.remember(high);
  assert.equal(alarm.evaluate(snapshot(e, NOW + 39000), { ...config, enabled: false }, NOW + 39000).length, 0);
  alarm.clear(); assert.equal(alarm.evaluate(snapshot(e, NOW + 39000), config, NOW + 39000).length, 0);
  const reloaded = createAlerts(), stored = { [high.key]: 3 };
  assert.equal(reloaded.evaluate(snapshot(e, NOW + 39000), config, NOW + 39000, stored).length, 0);
  assert.deepEqual(plain(parseAlertLedger(JSON.stringify(stored))), stored);
  for (const raw of ['bad', 'null', '[]', '{"__proto__":3}', JSON.stringify({ [high.key]: 4 })]) assert.throws(() => parseAlertLedger(raw));
  pass('同币已提醒等级不会因时间、清窗口、开关或刷新再响；仅升级，损坏记录拒绝放行');
}
{
  const e = create(), alarm = createAlerts();
  e.ingest([buy({ source: 'fomo', wallet: '', handle: 'alice' })], NOW);
  assert.equal(alarm.evaluate(snapshot(e), config, NOW).length, 1);
  e.ingest([buy(), buy({ source: 'pump' })], NOW + 31000);
  assert.equal(snapshot(e, NOW + 31000)[0].buyerCount, 1);
  assert.equal(alarm.evaluate(snapshot(e, NOW + 31000), config, NOW + 31000).length, 0);
  e.ingest([buy({ chain: 'base', usd: 11000 }), buy({ addr: B, usd: 3500 })], NOW + 32000);
  const hits = alarm.evaluate(snapshot(e, NOW + 32000), config, NOW + 32000);
  assert.deepEqual(plain(hits.map(h => h.level)), [3, 2]);
  pass('跨来源同笔交易与身份补全不重复报警；同名跨链/跨币隔离，批量命中按强度排序');
}
const tones = [];
class FakeAudio {
  state = 'suspended'; currentTime = 0; destination = {};
  resume() { this.state = 'running'; return Promise.resolve(); }
  createOscillator() { const t = { frequency: {}, connect() {}, disconnect() {}, start(at) { this.at = at; }, stop(at) { this.end = at; } }; tones.push(t); return t; }
  createGain() { const t = tones.at(-1); return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime(v) { t.volume = v; }, exponentialRampToValueAtTime() {} } }; }
}
const sound = createAlertSound(FakeAudio);
assert.equal(sound.play(1), false); assert.equal(await sound.unlock(), true);
assert.equal(sound.play(1), true); assert.equal(sound.play(1), false);
assert.equal(sound.play(3), true); assert.equal(tones.length, 4); sound.stop();
for (const level of [1, 2, 3]) { const before = tones.length; assert.equal(sound.play(level), true); assert.equal(tones.length - before, level); sound.stop(); }
assert.ok(tones[0].volume < tones[5].volume && tones[5].volume < tones.at(-1).volume);
assert.equal(await createAlertSound(undefined).unlock(), false);
pass('声音须用户解锁；1/2/3 声、逐级增益、短音包络、升级打断低档与即时停止');

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 950, height: 800 } });
  await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const source = code.replace('  // Bounded, visible-page-only maintenance.', `
    window.testAlerts = { mount(){active=started=true;body=makeBody();document.body.appendChild(body);paint(true);updateAlertStatus();},
      ingest(rows){engine.ingest(rows);}, tick(){return checkAlerts();}, close(){active=false;notifyVisibility();}, settings(){return soundConfig;},
      since(){return alertSince;}, soundReady(){return sound.ready();}, engineRows(){return engine.snapshot(filters).rows;}, createSound:createAlertSound };
    // Bounded, visible-page-only maintenance.`);
  const setup = async p => {
    await p.goto('https://gmgn.ai/bsc/token/' + T);
    await p.addStyleTag({ content: read('aggregate-monitor.css') + '.gdh-buy-monitor{width:340px;height:650px}' });
    await p.evaluate(() => {
      window.clock = 1789500000000; Date.now = () => window.clock; window.setInterval = () => 1; window.tones = [];
      window.AudioContext = class {
        state = 'suspended'; destination = {}; get currentTime(){return window.clock / 1000;}
        resume(){this.state='running';return Promise.resolve();}
        createOscillator(){const t={frequency:{},connect(){},disconnect(){},start(){},stop(){}};window.tones.push(t);return t;}
        createGain(){const t=window.tones.at(-1);return {connect(){},disconnect(){},gain:{setValueAtTime(){},linearRampToValueAtTime(v){t.peak=v;},exponentialRampToValueAtTime(){}}};}
      };
    });
    await p.addScriptTag({ content: source }); await p.evaluate(() => testAlerts.mount());
  };
  await setup(page);
  const box = page.locator('.gdh-buy-alerts'); await box.locator('summary').click();
  assert.equal(await box.locator('[data-alert-language]').inputValue(), 'en');
  assert.equal(await box.locator('[data-alert="enabled"]').isChecked(), false);
  const row = (patch = {}) => buy({ symbol: 'ALERT', ...patch });
  await page.evaluate(rows => { testAlerts.ingest(rows); return testAlerts.tick(); }, [row()]);
  assert.equal(await page.evaluate(() => tones.length), 0);
  await box.locator('[data-alert="enabled"]').check();
  await box.locator('button[type=submit]').click();
  assert.equal(await page.evaluate(() => testAlerts.settings().enabled), true);
  await page.evaluate(() => testAlerts.tick()); assert.equal(await page.evaluate(() => tones.length), 0);
  await page.evaluate(rows => { clock += 1000; testAlerts.ingest(rows); return testAlerts.tick(); }, [row({ ts: NOW + 1000, tx: '0x999' })]);
  assert.equal(await page.evaluate(() => tones.length), 1);
  await page.evaluate(() => { clock += 4000; return testAlerts.tick(); }); assert.equal(await page.evaluate(() => tones.length), 1);
  pass('生产设置英文默认、默认不响；启用需保存，旧快照不报，新事件实际驱动音频');
  await page.locator('[data-filter="minUsd"]').fill('999999999'); await page.locator('[data-filter="minUsd"]').dispatchEvent('change');
  await page.evaluate(rows => { testAlerts.close(); clock += 1000; testAlerts.ingest(rows); return testAlerts.tick(); }, [row({ ts: NOW + 6000, tx: '0xaa1', usd: 11000 })]);
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-gdh-buy-aggregate-active')), '1');
  assert.equal(await page.evaluate(() => tones.length), 4);
  assert.equal(await page.evaluate(() => testAlerts.engineRows().length), 0);
  pass('面板关闭仍订阅并可报警，列表展示筛选不影响警报阈值');
  await box.locator('[data-alert-language]').selectOption('zh');
  await box.locator('[data-alert="seconds"]').fill('15');
  await box.locator('[data-alert-language]').selectOption('en');
  assert.equal(await box.locator('[data-alert="seconds"]').inputValue(), '15');
  await box.locator('[data-alert-language]').selectOption('zh');
  await box.locator('button[type=submit]').click();
  await box.locator('form').evaluate(el => { el.scrollTop = 0; });
  await box.screenshot({ path: 'dist/aggregate-alerts-zh-v96.png' });
  assert.equal(await box.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.evaluate(() => document.documentElement.classList.add('light'));
  await box.screenshot({ path: 'dist/aggregate-alerts-light-v96.png' });
  pass('中英文切换不丢草稿，本地保存秒数；340px 窄面板无横向溢出，深浅主题截图');
  await setup(page);
  assert.equal(await page.locator('[data-alert-language]').inputValue(), 'zh');
  assert.equal(await page.locator('[data-alert="seconds"]').inputValue(), '15');
  assert.equal(await page.evaluate(() => testAlerts.soundReady()), false);
  assert.equal(await page.locator('[data-alert-unlock]').getAttribute('hidden'), null);
  await page.locator('.gdh-buy-alerts summary').click();
  await page.locator('[data-alert-unlock]').click();
  assert.equal(await page.evaluate(() => testAlerts.soundReady()), true);
  pass('刷新记住开关和阈值，但音频不假装已启用，提供显式解锁入口');
  const other = await context.newPage(); await setup(other);
  await other.evaluate(() => { const c = testAlerts.settings(); c.seconds = 90; localStorage.setItem('gdhBuyAggregateAlertsV1', JSON.stringify(c)); });
  await page.waitForFunction(() => testAlerts.settings().seconds === 90);
  await page.locator('.gdh-buy-alerts button[type=submit]').click();
  assert.match(await page.locator('[data-alert-message]').innerText(), /另一标签页/);
  await page.locator('[data-alert-reload]').click(); assert.equal(await page.locator('[data-alert="seconds"]').inputValue(), '90');
  await page.locator('[data-alert-mute]').click(); await other.waitForFunction(() => !testAlerts.settings().enabled);
  assert.equal(await page.evaluate(() => testAlerts.settings().enabled), false);
  const beforeTest = await page.evaluate(() => tones.length);
  await page.locator('[data-alert-test="2"]').click(); assert.equal(await page.evaluate(() => tones.length), beforeTest + 2);
  assert.equal(await page.evaluate(() => testAlerts.settings().enabled), false);
  pass('跨标签设置变化阻止旧草稿覆盖；关闭同步，试听不擅自启用警报');
  await page.locator('[data-alert="enabled"]').check(); await page.locator('.gdh-buy-alerts button[type=submit]').click();
  await other.waitForFunction(() => testAlerts.settings().enabled);
  await other.locator('.gdh-buy-alerts summary').click(); await other.locator('[data-alert-unlock]').click();
  const countsBefore = await Promise.all([page, other].map(p => p.evaluate(() => tones.length)));
  await Promise.all([page, other].map(p => p.evaluate(rows => {
    clock = 1789500120000; testAlerts.ingest(rows); return testAlerts.tick();
  }, [row({ addr: B, ts: NOW + 120000, tx: '0xb001', usd: 12000 })])));
  const countsAfter = await Promise.all([page, other].map(p => p.evaluate(() => tones.length)));
  assert.equal(countsAfter.reduce((s, x, i) => s + x - countsBefore[i], 0), 3);
  pass('两个 GMGN 标签同时命中通过本地 Web Lock 合并，只播放一组最高档');
  const rendered = await page.evaluate(async choices => {
    async function render(level, options, legacy = false) {
      const ctx = new OfflineAudioContext(1, 88200, 44100);
      function Adapter() { return { state: 'running', currentTime: 0, destination: ctx.destination, resume: () => Promise.resolve(),
        createOscillator: () => ctx.createOscillator(), createGain: () => ctx.createGain() }; }
      const sound = testAlerts.createSound(Adapter); await sound.unlock();
      let played;
      if (legacy) {
        played = true;
        for (let i = 0; i < level; i++) {
          const osc = ctx.createOscillator(), gain = ctx.createGain(), at = .01 + i * .26;
          osc.frequency.value = [0, 660, 880, 1100][level] + i * 80;
          gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime([0, .07, .12, .18][level], at + .015);
          gain.gain.exponentialRampToValueAtTime(.001, at + .16);
          osc.connect(gain); gain.connect(ctx.destination); osc.start(at); osc.stop(at + .18);
        }
      } else played = sound.play(level, options);
      const pcm = (await ctx.startRendering()).getChannelData(0);
      return { played, rms: Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / pcm.length), peak: pcm.reduce((m, x) => Math.max(m, Math.abs(x)), 0),
        last: pcm.findLastIndex(x => Math.abs(x) > .00001) / 44100 };
    }
    const styles = {};
    for (const [name] of choices) styles[name] = await Promise.all([1, 2, 3].map(l => render(l, { sound: name, volume: 100 })));
    return { styles, old: await render(3, {}, true), default: await render(3), half: await render(3, { volume: 50 }), zero: await render(3, { volume: 0 }) };
  }, plain(SOUND_CHOICES));
  for (const levels of Object.values(rendered.styles)) {
    assert.ok(levels[0].rms > 0 && levels[0].rms < levels[1].rms && levels[1].rms < levels[2].rms);
    assert.ok(levels[0].last < levels[1].last && levels[1].last < levels[2].last && levels[2].last < 1.8);
    assert.ok(levels.every(s => s.peak < .8));
  }
  assert.equal(new Set(Object.values(rendered.styles).map(levels => levels[2].rms.toFixed(6))).size, 6);
  assert.ok(rendered.default.rms > rendered.old.rms * 3);
  assert.ok(rendered.styles.beep[2].rms > rendered.half.rms * 1.9 && rendered.styles.beep[2].rms < rendered.half.rms * 2.1);
  assert.equal(rendered.zero.played, false); assert.equal(rendered.zero.peak, 0);
  fs.writeFileSync('dist/v96-audio-verification.json', JSON.stringify(rendered, null, 2));
  pass('真实离线波形：六种音色各三级均有效、不削波、短于 1.8 秒；默认 RMS 比旧版超 3 倍，音量线性且 0% 静音');
  const volume = page.locator('[data-alert="volume"]');
  const setVolume = v => volume.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
  await setVolume(90); assert.equal(await page.locator('[data-alert-volume-label]').innerText(), '90%');
  for (const [i, name] of ['chime', 'rise', 'alarm'].entries()) await page.locator(`[data-alert-sound="${i}"]`).selectOption(name);
  assert.equal(await page.locator('[data-alert-sound="0"] option').count(), 6);
  await page.locator('[data-alert-language]').selectOption('en');
  assert.equal(await page.locator('[data-alert-sound="0"]').inputValue(), 'chime');
  assert.equal(await page.locator('[data-alert-sound="0"] option:checked').innerText(), 'Chime');
  await page.locator('[data-alert-language]').selectOption('zh');
  assert.equal(await page.locator('[data-alert-sound="0"] option:checked').innerText(), '双音门铃');
  const beforeDraftTest = await page.evaluate(() => tones.length);
  await page.locator('[data-alert-test="1"]').click();
  assert.equal(await page.evaluate(() => tones.length), beforeDraftTest + 2);
  assert.equal(await page.evaluate(() => tones.at(-1).frequency.value), 1174);
  assert.ok(Math.abs(await page.evaluate(() => tones.at(-1).peak) - .342) < .00001);
  assert.equal(await page.evaluate(() => testAlerts.settings().volume), 80);
  await setVolume(0); const beforeZero = await page.evaluate(() => tones.length);
  await page.locator('[data-alert-test="3"]').click(); assert.equal(await page.evaluate(() => tones.length), beforeZero);
  assert.match(await page.locator('[data-alert-message]').innerText(), /0%/);
  await setVolume(90); await page.locator('.gdh-buy-alerts button[type=submit]').click();
  const afterConfig = await page.evaluate(() => testAlerts.settings());
  assert.equal(afterConfig.volume, 90); assert.deepEqual(afterConfig.levels.map(l => l.sound), ['chime', 'rise', 'alarm']);
  const beforeAuto = await page.evaluate(() => tones.length);
  await page.evaluate(rows => { clock += 5000; testAlerts.ingest(rows); return testAlerts.tick(); }, [row({ addr: '0x' + 'c'.repeat(40), ts: NOW + 125000, tx: '0xb002' })]);
  assert.equal(await page.evaluate(() => tones.length), beforeAuto + 2);
  assert.ok(Math.abs(await page.evaluate(() => tones.at(-1).peak) - .342) < .00001);
  pass('每档独立选六种声音，中英文切换不丢选择；试听按未保存音量，自动警报按已保存音量/音色，0% 明确静音');
  await setup(page); await page.locator('.gdh-buy-alerts summary').click();
  assert.equal(await page.locator('[data-alert="volume"]').inputValue(), '90');
  assert.equal(await page.locator('[data-alert-sound="2"]').inputValue(), 'alarm');
  await setVolume(30); await page.locator('[data-alert-sound="2"]').selectOption('bell');
  await page.locator('[data-alert-reload]').click();
  assert.equal(await volume.inputValue(), '90'); assert.equal(await page.locator('[data-alert-sound="2"]').inputValue(), 'alarm');
  await page.locator('.gdh-buy-alerts form').evaluate(el => { el.scrollTop = 0; });
  assert.equal(await page.locator('.gdh-buy-alerts form').evaluate(el => el.querySelector('button[type=submit]').getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom), true);
  assert.equal(await page.locator('.gdh-buy-alerts').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.locator('.gdh-buy-alerts').screenshot({ path: 'dist/aggregate-sound-choices-v96.png' });
  await page.evaluate(() => document.documentElement.classList.add('light'));
  await page.locator('.gdh-buy-alerts').screenshot({ path: 'dist/aggregate-sound-choices-light-v96.png' });
  pass('音量与各档音色刷新后保持，恢复草稿有效；340px 深浅主题不横向溢出');
  assert.equal(await page.locator('[data-alert="cooldown"]').count(), 0);
  assert.match(await page.locator('.gdh-buy-alert-once').innerText(), /每档仅提醒一次/);
  await page.locator('[data-alert-unlock]').click();
  const step = (patch, elapsed = 4000) => page.evaluate(({ base, patch, elapsed }) => {
    clock += elapsed; testAlerts.ingest([{ ...base, ...patch, ts: clock, tx: 'new-' + clock }]); return testAlerts.tick();
  }, { base: row(), patch, elapsed });
  await step({ usd: 15000 }); assert.equal(await page.evaluate(() => tones.length), 0);
  const D = '0x' + 'd'.repeat(40), E = '0x' + 'e'.repeat(40);
  await step({ addr: D }); assert.equal(await page.evaluate(() => tones.length), 2);
  await step({ addr: D, usd: 50 }, 31000); assert.equal(await page.evaluate(() => tones.length), 2);
  await step({ addr: D, usd: 4000 }); assert.equal(await page.evaluate(() => tones.length), 8);
  await page.locator('.gdh-buy-alerts button[type=submit]').click();
  await step({ addr: D, usd: 4000 }); assert.equal(await page.evaluate(() => tones.length), 8);
  await step({ addr: D, usd: 12000 }); assert.equal(await page.evaluate(() => tones.length), 14);
  await step({ addr: D, usd: 12000 }, 120000); assert.equal(await page.evaluate(() => tones.length), 14);
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem('gdhBuyAggregateAlertedLevelsV1'))[key], 'bsc|' + D), 3);
  await setup(page); await page.locator('.gdh-buy-alerts summary').click(); await page.locator('[data-alert-unlock]').click();
  await step({ addr: D, usd: 20000 }); assert.equal(await page.evaluate(() => tones.length), 0);
  await step({ addr: D, chain: 'base', usd: 20000 }); assert.equal(await page.evaluate(() => tones.length), 6);
  pass('真实 UI：每币各档最多一次，升级可响；超过原冷却、改设置、刷新后不重响，跨链独立');
  await page.evaluate(() => { window.originalStorageSet = Storage.prototype.setItem; Storage.prototype.setItem = function(k, v) {
    if (k === 'gdhBuyAggregateAlertedLevelsV1') throw new DOMException('quota', 'QuotaExceededError'); return originalStorageSet.call(this, k, v);
  }; });
  await step({ addr: E, usd: 20000 }); assert.equal(await page.evaluate(() => tones.length), 6);
  assert.match(await page.locator('[data-alert-status]').innerText(), /暂停/);
  await page.evaluate(() => { Storage.prototype.setItem = originalStorageSet; }); await page.locator('[data-alert-unlock]').click();
  await step({ addr: E, usd: 20000 }); assert.equal(await page.evaluate(() => tones.length), 12);
  pass('提醒记录写入失败不先播放，明确暂停；恢复后可重试未送达提醒，试听不占次数');
  assert.deepEqual(errors, []); pass('生产 UI 无未捕获异常');
} finally { await browser.close(); }
console.log(`Verified ${n} aggregate sound alert checks.`);
