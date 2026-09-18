/* GMGN native multi-buyer monitor. No API requests, trades or wallet operations. */
(() => {
  'use strict';
  const DAY = 86_400_000;
  const LIMIT = 20_000;
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const address = value => {
    const s = String(value || '').trim();
    return /^0x[\da-f]{40}$/i.test(s) ? s.toLowerCase() : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : '';
  };
  const safeImage = value => {
    try { const u = new URL(value, 'https://gmgn.ai'); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
  };
  function normalize(raw, now = Date.now()) {
    const source = ['gmgn', 'fomo', 'pump'].includes(raw?.source) ? raw.source : '';
    const chain = String(raw?.chain || '').toLowerCase();
    const token = address(raw?.addr);
    const wallet = address(raw?.wallet || raw?.pumpWallet);
    const handle = String(raw?.handle || '').trim().toLowerCase().slice(0, 64);
    const buyer = wallet ? `wallet:${wallet}` : source === 'fomo' && handle ? `fomo:${handle}` : '';
    let ts = positive(raw?.ts); if (ts < 1e11) ts *= 1000;
    const side = String(raw?.type || raw?.side || '').toLowerCase();
    if (!source || !/^[a-z][a-z0-9]{1,15}$/.test(chain) || !token || !buyer
      || !['buy', 'sell'].includes(side) || ts < now - DAY || ts > now + 5000) return null;
    const txRaw = String(raw?.tx || '').trim().slice(0, 180);
    const tx = /^0x[\da-f]+$/i.test(txRaw) ? txRaw.toLowerCase() : txRaw;
    const usd = positive(raw?.usd);
    const sourceKey = String(raw?.key || '').slice(0, 180);
    const key = `${chain}|${token}|${side}|${source}|${buyer}|${tx || sourceKey || `${ts}:${usd}`}`;
    const name = String(raw?.name || '').trim();
    return { key, sourceKey, source, chain, token, wallet, buyer, handle, ts, side, tx, usd,
      closed: side === 'sell' && typeof raw.closed === 'boolean' ? raw.closed : null,
      name: (name || handle || wallet).slice(0, 64), nameRank: name && !address(name) ? 2 : handle ? 1 : 0,
      avatar: raw?.avatar ? safeImage(raw.avatar) : '',
      symbol: String(raw?.symbol || '').slice(0, 40), img: raw?.img ? safeImage(raw.img) : '',
      mc: positive(raw?.mc), quote: String(raw?.quote || '').slice(0, 32) };
  }
  function create() {
    const events = new Map();
    let capped = false;
    function prune(now) {
      for (const [key, e] of events) if (e.ts < now - DAY) events.delete(key);
      if (events.size > LIMIT) {
        const old = [...events.values()].sort((a, b) => a.ts - b.ts).slice(0, events.size - LIMIT);
        for (const e of old) events.delete(e.key);
        capped = true;
      }
    }
    return {
      ingest(rows, now = Date.now()) {
        for (const raw of Array.isArray(rows) ? rows.slice(0, 2500) : []) {
          const e = normalize(raw, now); if (!e) continue;
          const old = events.get(e.key);
          // Enrichment must not erase a known amount / image / MC with an empty snapshot.
          events.set(e.key, old ? { ...old, ...e, usd: e.usd || old.usd, mc: e.mc || old.mc, closed: e.closed ?? old.closed,
            name: e.nameRank >= old.nameRank ? e.name : old.name, nameRank: Math.max(e.nameRank, old.nameRank),
            img: e.img || old.img, avatar: e.avatar || old.avatar, symbol: e.symbol || old.symbol, quote: e.quote || old.quote } : e);
        }
        prune(now);
      },
      removeSource(source) { for (const [key, e] of events) if (e.source === source) events.delete(key); },
      clear() { events.clear(); capped = false; },
      snapshot(options = {}, now = Date.now()) {
        prune(now);
        const requestedWindow = Number(options.windowMs);
        const windowMs = Number.isInteger(requestedWindow) && requestedWindow >= 1000 && requestedWindow <= DAY ? requestedWindow : 300_000;
        const relevant = [...events.values()].filter(e => e.ts >= now - windowMs && e.ts <= now
          && (!options.after || e.ts > options.after) && (!options.chain || options.chain === e.chain));
        const groups = new Map();
        for (const e of relevant) {
          const key = `${e.chain}|${e.token}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        }
        const rows = [];
        for (const [key, group] of groups) {
          const txWallets = new Map();
          for (const e of group) if (e.tx && e.wallet) {
            const k = `${e.side}|${e.tx}`;
            if (!txWallets.has(k)) txWallets.set(k, new Set());
            txWallets.get(k).add(e.buyer);
          }
          // A FOMO handle is NOT a wallet / nickname. Only an exact transaction with
          // one known maker can link the two identities; ambiguous multi-maker txs stay separate.
          const aliases = new Map();
          for (const e of group) if (!e.wallet && e.tx) {
            const ws = txWallets.get(`${e.side}|${e.tx}`);
            if (ws?.size === 1) {
              if (!aliases.has(e.buyer)) aliases.set(e.buyer, new Set());
              aliases.get(e.buyer).add([...ws][0]);
            }
          }
          const trades = new Map();
          for (const e of group) {
            const alias = aliases.get(e.buyer);
            const buyer = alias?.size === 1 ? [...alias][0] : e.buyer;
            const id = `${e.side}|${buyer}|${e.tx || (e.sourceKey ? `${e.source}:${e.sourceKey}` : `${e.ts}:${e.usd}`)}`;
            const old = trades.get(id);
            if (old) {
              old.sources.add(e.source); old.usd = Math.max(old.usd, e.usd); old.avatar ||= e.avatar;
              if (old.closed === null) old.closed = e.closed;
              else if (e.closed !== null && old.closed !== e.closed) old.closedConflict = true;
              if (e.nameRank > old.nameRank || e.nameRank === old.nameRank && e.ts >= old.ts) {
                old.name = e.name; old.nameRank = e.nameRank;
              }
            }
            else trades.set(id, { ...e, buyer, sources: new Set([e.source]) });
          }
          const people = new Map(); const sources = new Set();
          let buyUsd = 0, sellUsd = 0, buyCount = 0, sellCount = 0, unknownAmounts = 0, unknownSellAmounts = 0;
          for (const t of trades.values()) {
            if (!people.has(t.buyer)) people.set(t.buyer, { id: t.buyer, name: '', nameRank: -1, nameTs: 0, avatar: '', avatarTs: 0,
              usd: 0, count: 0, sellUsd: 0, sellCount: 0, unknownAmounts: 0, unknownSellAmounts: 0, positionTs: 0, closed: null, sources: new Set() });
            const b = people.get(t.buyer);
            if (t.side === 'buy') {
              buyCount++; buyUsd += t.usd; if (!t.usd) unknownAmounts++;
              b.usd += t.usd; b.count++; if (!t.usd) b.unknownAmounts++;
            } else {
              sellCount++; sellUsd += t.usd; if (!t.usd) unknownSellAmounts++;
              b.sellUsd += t.usd; b.sellCount++; if (!t.usd) b.unknownSellAmounts++;
            }
            const closed = t.side === 'buy' ? false : t.closedConflict ? null : t.closed;
            if (t.ts > b.positionTs) { b.positionTs = t.ts; b.closed = closed; }
            else if (t.ts === b.positionTs && b.closed !== closed) b.closed = null; // no ordering guess within the same timestamp
            if (t.nameRank > b.nameRank || t.nameRank === b.nameRank && t.ts >= b.nameTs) {
              b.name = t.name; b.nameRank = t.nameRank; b.nameTs = t.ts;
            }
            if (t.avatar && t.ts >= b.avatarTs) { b.avatar = t.avatar; b.avatarTs = t.ts; }
            for (const s of t.sources) { sources.add(s); b.sources.add(s); }
          }
          if (!buyCount) continue;
          const participants = [...people.values()].sort((a, b) => b.usd - a.usd || b.sellUsd - a.sellUsd);
          const buyers = participants.filter(b => b.count > 0), sellers = participants.filter(b => b.sellCount > 0);
          const latest = group.slice().sort((a, b) => b.ts - a.ts);
          const meta = field => latest.find(e => e[field])?.[field] || '';
          rows.push({ key, chain: latest[0].chain, token: latest[0].token, symbol: meta('symbol'), img: meta('img'),
            mc: meta('mc'), quote: meta('quote'), lastTs: Math.max(...group.filter(e => e.side === 'buy').map(e => e.ts)),
            buyUsd, sellUsd, buyCount, sellCount, buyerCount: buyers.length, sellerCount: sellers.length, unknownAmounts, unknownSellAmounts,
            netUsd: buyUsd - sellUsd, netComplete: unknownAmounts === 0 && unknownSellAmounts === 0,
            closedCount: sellers.filter(b => b.closed === true).length, unknownCloseCount: sellers.filter(b => b.closed === null).length,
            buyers, people: participants, sources: [...sources],
            ...(options.includeBuyKeys ? { buyKeys: [...trades].filter(([, t]) => t.side === 'buy').map(([id, t]) => t.tx ? `tx:${t.tx}` : id) } : {}) });
        }
        const minBuyers = Math.max(1, Number(options.minBuyers) || 2);
        const minUsd = positive(options.minUsd);
        const filtered = rows.filter(r => r.buyerCount >= minBuyers && r.buyUsd >= minUsd);
        const sort = ['buyerCount', 'buyUsd', 'lastTs'].includes(options.sort) ? options.sort : 'buyerCount';
        filtered.sort((a, b) => b[sort] - a[sort] || b.buyUsd - a.buyUsd || b.lastTs - a.lastTs || a.key.localeCompare(b.key));
        return { rows: filtered, events: events.size, capped, windowMs };
      },
    };
  }
  const SOUND_CHOICES = [
    ['beep', 'Beep', '清脆提示'], ['bell', 'Bell', '铃声'], ['chime', 'Chime', '双音门铃'],
    ['rise', 'Ascending', '上扬音阶'], ['radar', 'Radar', '雷达'], ['alarm', 'Alarm', '警报'],
  ];
  const ALERT_DEFAULTS = { enabled: false, seconds: 60, volume: 80, levels: [
    { enabled: true, usd: 1000, buyers: 3 }, { enabled: true, usd: 3000, buyers: 5 }, { enabled: true, usd: 10000, buyers: 8 },
  ] };
  function alertSettings(raw = ALERT_DEFAULTS) {
    if (!raw || typeof raw !== 'object') return null;
    const seconds = Number(raw.seconds), volume = raw.volume === undefined ? 80 : Number(raw.volume);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600
      || !Number.isInteger(volume) || volume < 0 || volume > 100
      || !Array.isArray(raw.levels) || raw.levels.length !== 3) return null;
    const levels = raw.levels.map(l => ({ enabled: l?.enabled === true, usd: Number(l?.usd), buyers: Number(l?.buyers), sound: l?.sound === undefined ? 'beep' : l.sound }));
    if (levels.some(l => !Number.isFinite(l.usd) || l.usd < 0 || l.usd > 1e12 || !Number.isInteger(l.buyers) || l.buyers < 0 || l.buyers > 10000
      || !SOUND_CHOICES.some(([id]) => id === l.sound)
      || l.enabled && !l.usd && !l.buyers) || raw.enabled === true && !levels.some(l => l.enabled)) return null;
    return { enabled: raw.enabled === true, seconds, volume, levels };
  }
  function alertLevel(row, settings) {
    let level = 0;
    settings.levels.forEach((l, i) => {
      if (l.enabled && (l.usd > 0 && row.buyUsd > l.usd || l.buyers > 0 && row.buyerCount >= l.buyers)) level = i + 1;
    });
    return level;
  }
  function createAlerts() {
    const states = new Map(), fired = new Map();
    return {
      // Settings / visibility changes reset the current window, never delivered levels.
      clear() { states.clear(); },
      remember(hit) { fired.set(hit.key, Math.max(fired.get(hit.key) || 0, hit.level)); },
      evaluate(rows, settings, now = Date.now(), delivered = {}) {
        if (!settings.enabled) { states.clear(); return []; }
        const hits = [];
        for (const row of rows) {
          const old = states.get(row.key), keys = new Set(row.buyKeys || []), level = alertLevel(row, settings);
          const fresh = [...keys].some(k => !old?.keys.has(k)) || row.buyUsd > (old?.usd || 0) || row.buyerCount > (old?.buyers || 0);
          const state = { keys, usd: row.buyUsd, buyers: row.buyerCount, seen: now };
          if (fresh && level > Math.max(fired.get(row.key) || 0, delivered[row.key] || 0)) {
            hits.push({ ...row, level });
          }
          states.set(row.key, state);
        }
        for (const [key, s] of states) if (now - s.seen > settings.seconds * 1000) states.delete(key);
        return hits.sort((a, b) => b.level - a.level || b.buyUsd - a.buyUsd);
      },
    };
  }
  function parseAlertLedger(raw) {
    if (raw === null) return {};
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid alert ledger');
    for (const [key, level] of Object.entries(value)) {
      const [chain, token, extra] = key.split('|');
      if (extra !== undefined || !/^[a-z][a-z0-9]{1,15}$/.test(chain) || !token || address(token) !== token || ![1, 2, 3].includes(level)) throw new Error('Invalid alert ledger');
    }
    return value;
  }
  // Short synthesized tones only: no remote audio, notification permission or endless alarm loop.
  const SOUND_PATTERNS = {
    beep: { wave: 'sine', notes: [880], duration: .28, hold: .12, gain: 1 },
    bell: { wave: 'triangle', notes: [1568], duration: .36, hold: .025, gain: 1 },
    chime: { wave: 'sine', notes: [880, 1174], duration: .20, hold: .08, gain: 1 },
    rise: { wave: 'triangle', notes: [523, 659, 784], duration: .10, hold: .04, gain: 1 },
    radar: { wave: 'sine', notes: [1250], duration: .35, hold: .10, gain: 1, sweep: 450 },
    alarm: { wave: 'square', notes: [880, 660], duration: .22, hold: .12, gain: .65 },
  };
  function createAlertSound(Context) {
    let audio, busyUntil = 0, playingLevel = 0;
    const nodes = new Set();
    return {
      ready() { return audio?.state === 'running'; },
      async unlock() {
        if (!Context) return false;
        try { audio ||= new Context(); await audio.resume(); return audio.state === 'running'; } catch { return false; }
      },
      stop() {
        for (const node of nodes) { try { node.stop(); } catch { /* already stopped */ } }
        nodes.clear(); busyUntil = 0; playingLevel = 0;
      },
      canPlay(level, options = {}) {
        const volume = options.volume === undefined ? 80 : Number(options.volume), kind = options.sound || 'beep';
        return audio?.state === 'running' && [1, 2, 3].includes(level) && Object.hasOwn(SOUND_PATTERNS, kind)
          && Number.isFinite(volume) && volume > 0 && volume <= 100 && (audio.currentTime >= busyUntil || level > playingLevel);
      },
      play(level, options = {}) {
        if (!this.canPlay(level, options)) return false;
        const volume = options.volume === undefined ? 80 : Number(options.volume), kind = options.sound || 'beep';
        if (audio.currentTime < busyUntil) this.stop();
        const p = SOUND_PATTERNS[kind], start = audio.currentTime + .01, cycle = p.notes.length * p.duration + .12;
        const peak = [0, .38, .52, .68][level] * volume / 100 * p.gain;
        for (let i = 0; i < level; i++) for (let j = 0; j < p.notes.length; j++) {
          const osc = audio.createOscillator(), gain = audio.createGain(), at = start + i * cycle + j * p.duration;
          osc.type = p.wave; osc.frequency.value = p.notes[j];
          if (p.sweep) { osc.frequency.setValueAtTime(p.notes[j], at); osc.frequency.exponentialRampToValueAtTime(p.sweep, at + p.duration); }
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(peak, at + .015);
          gain.gain.setValueAtTime(peak, at + p.hold);
          gain.gain.exponentialRampToValueAtTime(.001, at + p.duration - .015);
          osc.connect(gain); gain.connect(audio.destination); nodes.add(osc);
          osc.onended = () => { nodes.delete(osc); osc.disconnect(); gain.disconnect(); };
          osc.start(at); osc.stop(at + p.duration);
        }
        busyUntil = start + level * cycle; playingLevel = level; return true;
      },
    };
  }
  const api = { create, normalize, address, nativeEvent, alertSettings, alertLevel, createAlerts, parseAlertLedger, createAlertSound, SOUND_CHOICES };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (location.hostname !== 'gmgn.ai' || window.__gdhBuyMonitor) return;
  window.__gdhBuyMonitor = true;

  const ID = 'GDH_BUY_AGGREGATE_V1';
  const ATTR = 'data-gdh-buy-aggregate-feeds';
  const FILTER_KEY = 'gdhBuyAggregateFiltersV1';
  const ALERT_KEY = 'gdhBuyAggregateAlertsV1', ALERT_LANG_KEY = 'gdhBuyAggregateAlertLanguageV1';
  const ALERT_LEDGER_KEY = 'gdhBuyAggregateAlertedLevelsV1';
  let ledgerRaw, ledgerCache, alertLedgerError = '';
  function readAlertLedger() {
    const raw = localStorage.getItem(ALERT_LEDGER_KEY);
    if (raw !== ledgerRaw) { ledgerCache = parseAlertLedger(raw); ledgerRaw = raw; }
    return ledgerCache;
  }
  let soundConfig = alertSettings(), soundLanguage = 'en', alertSince = Date.now(), nextAlertCheck = 0, lastAlert = null;
  try { soundConfig = alertSettings(JSON.parse(localStorage.getItem(ALERT_KEY))) || soundConfig; soundLanguage = localStorage.getItem(ALERT_LANG_KEY) === 'zh' ? 'zh' : 'en'; } catch { /* safe off defaults */ }
  const alerts = createAlerts(), sound = createAlertSound(window.AudioContext || window.webkitAudioContext);
  // Same defaults and user preference key as the existing GMGN tracking feed.
  const CHAIN_COLORS = {
    sol: '#7b44f2', bsc: '#eab204', base: '#3073ff', eth: '#4d84f7', robinhood: '#9fc700',
    stable: '#007b4f', arc: '#5c8de5', xlayer: '#4a4a4a', hyperevm: '#55c6ab',
    megaeth: '#2a2a2a', monad: '#6a52f1',
  };
  function chainColor(chain, preferences) {
    const custom = preferences?.[chain]?.color;
    if (typeof custom === 'string' && CSS.supports('color', custom)) return custom;
    return Object.hasOwn(CHAIN_COLORS, chain) ? CHAIN_COLORS[chain] : '#8a93a6';
  }
  const engine = create();
  let walletMarks = { evm: {}, sol: {} }, marksReading = false, nextMarksRead = 0;
  function readWalletMarks() {
    // GMGN stores personal remarks separately from trade nicknames. Read only the
    // two known remark keys; never enumerate user storage or call the remarks API.
    return new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value); } };
      try {
        const request = indexedDB.open('gmgn');
        request.onupgradeneeded = () => request.transaction.abort(); // do not create / migrate GMGN's DB
        request.onerror = request.onblocked = () => finish(null);
        request.onsuccess = () => {
          const db = request.result;
          if (done) { db.close(); return; }
          try {
            const tx = db.transaction('app_state', 'readonly'), result = {};
            for (const scope of ['evm', 'sol']) {
              const get = tx.objectStore('app_state').get(`mark_wallet_v1_${scope}`);
              get.onsuccess = () => { const value = get.result; result[scope] = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
            }
            tx.oncomplete = () => { db.close(); finish(result); };
            tx.onerror = tx.onabort = () => { db.close(); finish(null); };
          } catch { db.close(); finish(null); }
        };
      } catch { finish(null); }
    });
  }
  async function refreshWalletMarks(force = false) {
    if (marksReading || !force && Date.now() < nextMarksRead) return;
    nextMarksRead = Date.now() + 5000; marksReading = true;
    try {
      const next = await readWalletMarks();
      if (next) { walletMarks = next; revision++; }
    } finally { marksReading = false; }
  }
  function displayBuyer(buyer, chain) {
    if (!buyer.id.startsWith('wallet:')) return buyer;
    const wallet = address(buyer.id.slice(7));
    const scope = wallet.startsWith('0x') ? 'evm' : chain === 'sol' ? 'sol' : '';
    const mark = walletMarks[scope]?.[wallet];
    const name = typeof mark?.mark === 'string' ? mark.mark.trim().slice(0, 64) : '';
    return { ...buyer, name: name || buyer.name, avatar: mark?.image ? safeImage(mark.image) || buyer.avatar : buyer.avatar };
  }
  let req, deps, root, rootHost, button, body, list, status, controls, context;
  let active = false, started = soundConfig.enabled, mountingError = '', sourceFlags = { fomo: true, pump: true };
  let dataArrays = new WeakSet(), nextScan = 0, lastPaint = 0, revision = 0, paintedRevision = -1;
  const expanded = new Set();
  let pointerBusy = false, lastListHtml = '';
  let filters = { windowMs: 300_000, minBuyers: 2, minUsd: 0, sort: 'buyerCount', chain: '' };
  try { const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); if (saved && typeof saved === 'object') filters = { ...filters, ...saved }; } catch { /* storage is optional */ }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => n > 0 ? '$' + (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)) : '—';
  const flowMoney = (usd, missing = 0) => missing ? usd > 0 ? `${money(usd)}+` : '—' : usd === 0 ? '$0' : money(usd);
  const netMoney = (usd, complete) => complete ? `${usd > 0 ? '+' : usd < 0 ? '-' : ''}${flowMoney(Math.abs(usd))}` : '—';
  const alertText = (en, zh) => soundLanguage === 'zh' ? zh : en;
  function updateAlertStatus() {
    const el = body?.querySelector('[data-alert-status]'); if (!el) return;
    const label = !soundConfig.enabled ? alertText('Off', '已关闭') : alertLedgerError || (soundConfig.volume === 0 ? alertText('Muted (0%)', '静音（0%）') : !sound.ready() ? alertText('Click Enable audio', '请点击启用声音')
      : alertText('Listening', '监听中'));
    const text = lastAlert && soundConfig.enabled ? `${label} · L${lastAlert.level} ${lastAlert.symbol || lastAlert.token.slice(0, 8)} · ${money(lastAlert.buyUsd)} / ${lastAlert.buyerCount}` : label;
    if (el.textContent !== text) el.textContent = text;
    el.title = text;
    const unlock = body.querySelector('[data-alert-unlock]'); unlock.hidden = !soundConfig.enabled || sound.ready() && !alertLedgerError;
  }
  function resetAlerts() { alerts.clear(); alertLedgerError = ''; alertSince = Date.now(); lastAlert = null; nextAlertCheck = 0; started ||= soundConfig.enabled; notifyVisibility(); updateAlertStatus(); }
  function makeAlertControls() {
    const box = document.createElement('details'); box.className = 'gdh-buy-alerts';
    const label = (en, zh) => `<span data-alert-en="${en}" data-alert-zh="${zh}">${alertText(en, zh)}</span>`;
    box.innerHTML = `<summary>${label('Sound alerts', '声音警报')} <em>NEW</em><small data-alert-status></small></summary>
      <form><div class="gdh-buy-alert-heading"><label><input type="checkbox" data-alert="enabled">${label('Enable alerts', '开启声音警报')}</label>
      <select aria-label="Language / 语言" data-alert-language><option value="en">English</option><option value="zh">中文</option></select></div>
      <div class="gdh-buy-alert-timing"><label>${label('Window (seconds)', '统计窗口（秒）')}<input data-alert="seconds" aria-label="Window seconds" type="number" min="1" max="3600" step="1" required></label>
      <div class="gdh-buy-alert-once">${label('Same chain + token', '同链同币')}<strong>${label('Once per level', '每档仅提醒一次')}</strong></div></div>
      <label class="gdh-buy-alert-volume">${label('Volume', '音量')}<input data-alert="volume" aria-label="Alert volume" type="range" min="0" max="100" step="1"><output data-alert-volume-label></output></label>
      <div class="gdh-buy-alert-grid"><b>${label('Level', '等级')}</b><b>${label('Buy USD >', '买入金额 $ >')}</b><b>${label('Buyers ≥', '买家数 ≥')}</b><b>${label('Test', '试听')}</b>
      ${[['Low', '轻'], ['Medium', '中'], ['High', '强']].map(([en, zh], i) => `<label><input type="checkbox" data-alert-level="${i}">${label(en, zh)}</label>
        <input data-alert-usd="${i}" aria-label="${en} buy USD" type="number" min="0" max="1000000000000" step="any" required>
        <input data-alert-buyers="${i}" aria-label="${en} buyers" type="number" min="0" max="10000" step="1" required>
        <button type="button" data-alert-test="${i + 1}" aria-label="Test ${en} sound">${i + 1} ♪</button>
        <label class="gdh-buy-alert-tone">${label('Sound', '提示音')}<select data-alert-sound="${i}" aria-label="${en} sound">${SOUND_CHOICES.map(([id, en, zh]) => `<option value="${id}" data-alert-en="${en}" data-alert-zh="${zh}">${alertText(en, zh)}</option>`).join('')}</select></label>`).join('')}</div>
      <p>${label('Either threshold triggers; 0 ignores it. Highest level wins (1 / 2 / 3 sound sequences). Test uses your unsaved sound and volume; start low with headphones.', '金额或人数任一达标即触发；0 忽略该项。只响最高档（1 / 2 / 3 组提示音）。试听使用当前未保存的音量和提示音，戴耳机请先调低。')}</p>
      <p>${label('Each token only alerts on a higher level. Saved locally across reloads and tabs; no timed repeats or lower-level replay. Tests do not consume alerts.', '同币只在升级时再提醒，最高档触发后不再提醒低档。本地记忆跨刷新和标签页，不按冷却循环；试听不占提醒次数。')}</p>
      <p>${label('Per token across all chains; unique buyers from received GMGN / FOMO / Pump buys. List filters do not limit alerts. Old records are skipped.', '全链按同链同币统计追踪 / FOMO / Pump 已接收买入，买家去重。列表筛选不限制警报；启用前旧记录不报警。')}</p>
      <p>${label('Keeps listening when this panel is closed. Keep GMGN tracking loaded; suspended tabs, muted tabs or missing feeds cannot sound reliably.', '关闭此面板仍监听；需保持 GMGN 追踪已加载。标签页休眠、静音或数据源断开时无法保证警报。')}</p>
      <div class="gdh-buy-alert-actions"><button type="submit">${label('Save', '保存')}</button><button type="button" data-alert-mute>${label('Mute', '关闭警报')}</button>
      <button type="button" data-alert-unlock hidden>${label('Enable audio', '启用声音')}</button><button type="button" data-alert-reload>${label('Revert edits', '恢复已保存')}</button></div><div data-alert-message role="status"></div></form>`;
    const form = box.querySelector('form'), message = box.querySelector('[data-alert-message]');
    form.querySelector('p').before(form.querySelector('.gdh-buy-alert-actions'), message);
    let loadedSignature = JSON.stringify(soundConfig);
    const fill = () => {
      loadedSignature = JSON.stringify(soundConfig);
      for (const key of ['enabled', 'seconds', 'volume']) {
        const input = box.querySelector(`[data-alert="${key}"]`); input[key === 'enabled' ? 'checked' : 'value'] = soundConfig[key];
      }
      soundConfig.levels.forEach((l, i) => {
        box.querySelector(`[data-alert-level="${i}"]`).checked = l.enabled;
        box.querySelector(`[data-alert-usd="${i}"]`).value = l.usd;
        box.querySelector(`[data-alert-buyers="${i}"]`).value = l.buyers;
        box.querySelector(`[data-alert-sound="${i}"]`).value = l.sound;
      });
      box.querySelector('[data-alert-volume-label]').textContent = `${soundConfig.volume}%`;
    };
    box.querySelector('[data-alert="volume"]').addEventListener('input', e => { box.querySelector('[data-alert-volume-label]').textContent = `${e.target.value}%`; });
    box.querySelector('[data-alert-language]').value = soundLanguage; fill();
    box.addEventListener('pointerdown', e => e.stopPropagation());
    box.addEventListener('click', e => e.stopPropagation());
    box.querySelector('[data-alert-language]').addEventListener('change', e => {
      soundLanguage = e.target.value === 'zh' ? 'zh' : 'en';
      for (const span of box.querySelectorAll('[data-alert-en]')) span.textContent = span.dataset[soundLanguage === 'zh' ? 'alertZh' : 'alertEn'];
      try { localStorage.setItem(ALERT_LANG_KEY, soundLanguage); } catch { /* session language */ }
      message.textContent = ''; updateAlertStatus(); revision++; paint(true);
    });
    box.querySelector('[data-alert-reload]').addEventListener('click', () => { fill(); message.textContent = ''; });
    const save = (config, force = false) => {
      if (!force && loadedSignature !== JSON.stringify(soundConfig)) {
        message.textContent = alertText('Settings changed in another tab. Revert edits before saving.', '另一标签页已修改设置，请先恢复已保存再编辑。'); return false;
      }
      try { localStorage.setItem(ALERT_KEY, JSON.stringify(config)); } catch {
        message.textContent = alertText('Storage unavailable; settings not saved.', '本地存储不可用，设置未保存。'); return false;
      }
      soundConfig = config; loadedSignature = JSON.stringify(config); resetAlerts(); return true;
    };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const config = alertSettings({ enabled: box.querySelector('[data-alert="enabled"]').checked,
        seconds: box.querySelector('[data-alert="seconds"]').value, volume: box.querySelector('[data-alert="volume"]').value,
        levels: [0, 1, 2].map(i => ({ enabled: box.querySelector(`[data-alert-level="${i}"]`).checked,
          usd: box.querySelector(`[data-alert-usd="${i}"]`).value, buyers: box.querySelector(`[data-alert-buyers="${i}"]`).value, sound: box.querySelector(`[data-alert-sound="${i}"]`).value })) });
      if (!config) { message.textContent = alertText('Check ranges; enable a level with a positive threshold.', '请检查数值范围，至少启用一档且该档有非零门槛。'); return; }
      if (!save(config)) return;
      sound.stop(); if (config.enabled) await sound.unlock();
      // Discard anything received before the user's activation finishes, not only before save.
      alertSince = Date.now(); updateAlertStatus();
      message.textContent = config.enabled && !sound.ready() ? alertText('Saved. Click Enable audio to allow sound.', '已保存，请点击启用声音。') : alertText('Saved locally.', '已在本地保存。');
    });
    box.querySelector('[data-alert-mute]').addEventListener('click', () => {
      sound.stop(); const off = { ...soundConfig, enabled: false };
      if (save(off, true)) { fill(); message.textContent = alertText('Alerts off.', '警报已关闭。'); }
      else { soundConfig = off; resetAlerts(); }
    });
    box.querySelector('[data-alert-unlock]').addEventListener('click', async () => {
      const ok = await sound.unlock(); resetAlerts();
      message.textContent = ok ? alertText('Audio enabled for new buys.', '声音已启用，开始监听新买入。') : alertText('Audio blocked; check browser sound permissions.', '声音未启用，请检查浏览器声音权限。');
    });
    for (const btn of box.querySelectorAll('[data-alert-test]')) btn.addEventListener('click', async () => {
      const wasReady = sound.ready();
      const volume = Number(box.querySelector('[data-alert="volume"]').value), level = Number(btn.dataset.alertTest);
      if (await sound.unlock()) {
        if (!wasReady && soundConfig.enabled) resetAlerts(); sound.stop();
        const played = sound.play(level, { volume, sound: box.querySelector(`[data-alert-sound="${level - 1}"]`).value });
        message.textContent = played ? alertText('Test played; no settings changed.', '已播放试听，未修改设置。') : alertText('Volume is 0%; increase it to test.', '当前音量为 0%，请调高后试听。');
      }
      else message.textContent = alertText('Audio blocked by browser.', '声音被浏览器阻止。');
      updateAlertStatus();
    });
    return box;
  }
  let alertSoundPending = false;
  async function checkAlerts(now = Date.now()) {
    updateAlertStatus();
    if (!soundConfig.enabled || soundConfig.volume === 0 || !sound.ready() || alertLedgerError || now < nextAlertCheck || alertSoundPending) return;
    nextAlertCheck = now + 1000;
    const since = alertSince;
    alertSoundPending = true;
    try {
      const hits = alerts.evaluate(engine.snapshot({ windowMs: soundConfig.seconds * 1000, after: alertSince, minBuyers: 1, includeBuyKeys: true }, now).rows, soundConfig, now, readAlertLedger());
      if (!hits.length) return;
      const play = () => {
        if (!soundConfig.enabled || since !== alertSince || !sound.ready()) return;
        // Recheck within a same-origin lock; remember delivery before playing so a
        // refresh / second tab cannot replay it. Never expire this ledger by time.
        const ledger = readAlertLedger(), hit = hits.find(h => h.level > (ledger[h.key] || 0));
        if (!hit) return;
        // Coalesce bursts and the same alert in multiple GMGN tabs. No queued alarm backlog.
        let previous;
        try { previous = JSON.parse(localStorage.getItem('gdhBuyAggregateLastSoundV1')); } catch { /* optional */ }
        if (previous && now - previous.at >= 0 && now - previous.at < 3000 && hit.level <= previous.level) return;
        const options = { volume: soundConfig.volume, sound: soundConfig.levels[hit.level - 1].sound };
        if (!sound.canPlay(hit.level, options)) return;
        localStorage.setItem(ALERT_LEDGER_KEY, JSON.stringify({ ...ledger, [hit.key]: hit.level }));
        if (!sound.play(hit.level, options)) return;
        alerts.remember(hit);
        try { localStorage.setItem('gdhBuyAggregateLastSoundV1', JSON.stringify({ at: now, level: hit.level })); } catch { /* per-token ledger is already durable */ }
        lastAlert = hit; updateAlertStatus();
      };
      if (navigator.locks?.request) await navigator.locks.request('gdh-buy-aggregate-sound', { ifAvailable: true }, lock => { if (lock) play(); });
      else throw new Error('Unique alert lock unavailable');
    } catch {
      alertLedgerError = alertText('Alert history unavailable; sound paused', '无法保存提醒记录，声音已暂停');
      updateAlertStatus();
    }
    finally { alertSoundPending = false; }
  }
  function currentFiber(element) {
    let f = element?.[Object.keys(element || {}).find(k => k.startsWith('__reactFiber$'))];
    let top = f; for (let i = 0; top?.return && i < 120; i++) top = top.return;
    if (top?.stateNode?.current && top.stateNode.current !== top) f = f?.alternate || f;
    return f;
  }
  function readProviders() {
    let f = currentFiber(document.querySelector('[data-sentry-component="AttachContainer"]'));
    const providers = []; let rnd = null;
    for (let i = 0; f && i < 120; f = f.return, i++) {
      if (f.tag !== 10 || !f.memoizedProps) continue;
      const value = f.memoizedProps.value;
      const type = f.type?.Provider ? f.type : f.type?._context;
      if (!type) continue;
      providers.push({ type, value });
      if (value?.setStateData && value?.setAttachPos && value?.portalDoms) rnd = value;
    }
    return rnd ? { providers, rnd } : null;
  }
  function discover() {
    if (deps) return deps;
    if (!req) try { self.webpackChunk_N_E?.push([[`gdh-buy-${Date.now()}`], {}, r => { req = r; }]); } catch { return null; }
    if (!req?.m) return null;
    const entries = Object.entries(req.m);
    const native = entries.find(([, fn]) => { const s = String(fn); return s.includes('CustomRndView.tsx') && s.includes('portalDoms') && s.includes('useRndCtx'); });
    const client = entries.find(([, fn]) => /\.createRoot\s*=/.test(String(fn)) && String(fn).includes('hydrateRoot'));
    if (!native || !client) return null;
    try {
      const imported = [...new Set([...String(native[1]).matchAll(/\w+\((\d+)\)/g)].map(m => m[1]))];
      const React = imported.map(id => req(id)).find(m => m?.createElement && m?.useState);
      const Rnd = Object.values(req(native[0])).find(v => v?.type && String(v.type).includes('portalDoms'));
      const dom = req(client[0]);
      if (React && Rnd && dom?.createRoot) deps = { React, Rnd, dom };
    } catch { /* fail closed if GMGN changes its modules */ }
    return deps;
  }
  function notifyVisibility() {
    document.documentElement.setAttribute('data-gdh-buy-aggregate-active', active || soundConfig.enabled ? '1' : '0');
    document.dispatchEvent(new Event('gdh-buy-aggregate-request'));
  }
  function setOwnState(update) {
    const next = readProviders(); if (!next) return;
    next.rnd.setStateData(previous => {
      const old = previous?.[ID] || defaultState();
      return { ...previous, [ID]: typeof update === 'function' ? update(old) : update };
    });
    setTimeout(syncRoot, 0);
  }
  function defaultState() {
    return { visible: false, type: 'modal', modalRnd: { size: { width: 360, height: 540 },
      position: { x: Math.max(20, Math.min(innerWidth - 380, 460)), y: 120 } }, attachRnd: { layout: 'left', size: { width: 340, height: '100%' } } };
  }
  function navigate(e) {
    const link = e.target.closest('a[data-aggregate-token]');
    if (!link || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    document.documentElement.setAttribute('data-gdh-nav', link.getAttribute('href'));
    document.documentElement.setAttribute('data-gdh-nav-spa-only', '1');
    document.dispatchEvent(new Event('gdh-navigate'));
  }
  function makeBody() {
    const el = document.createElement('section'); el.className = 'gdh-buy-monitor';
    el.innerHTML = `<header><strong>聚合监控</strong><span>追踪 / FOMO / Pump</span></header>
      <div class="gdh-buy-controls">
        <select aria-label="统计时间窗口" data-filter="windowMs"><option value="300000">5 分钟</option><option value="900000">15 分钟</option><option value="3600000">1 小时</option><option value="86400000">24 小时</option></select>
        <select aria-label="聚合排序" data-filter="sort"><option value="buyerCount">买入人数 ↓</option><option value="buyUsd">买入金额 ↓</option><option value="lastTs">最新买入 ↓</option></select>
        <select aria-label="聚合链筛选" data-filter="chain"><option value="">全部链</option></select>
        <label>人数 ≥ <input aria-label="最少买入人数" data-filter="minBuyers" type="number" min="1" max="10000" step="1"></label>
        <label>买入 $ ≥ <input aria-label="最少买入金额" data-filter="minUsd" type="number" min="0" step="any"></label>
      </div><div class="gdh-buy-status" role="status"></div><div class="gdh-buy-list"></div>
      <footer title="按钱包 / FOMO 账号去重；不同来源无法确认同一人的身份时分别统计。仅本页已接收的事件，不补抓历史；卖出不减少买入人数。">本地已接收数据 · 买入金额 USD · 不代表当前持仓</footer>`;
    controls = el.querySelector('.gdh-buy-controls'); list = el.querySelector('.gdh-buy-list'); status = el.querySelector('.gdh-buy-status');
    controls.after(makeAlertControls());
    for (const input of controls.querySelectorAll('[data-filter]')) input.value = filters[input.dataset.filter];
    // Native Rnd owns the title drag handle; interacting with rows/inputs must not drag.
    for (const block of [controls, list]) block.addEventListener('pointerdown', e => {
      if (block === list) pointerBusy = true;
      e.stopPropagation();
    });
    controls.addEventListener('change', e => {
      const k = e.target.dataset.filter; if (!k) return;
      filters[k] = ['windowMs', 'minBuyers', 'minUsd'].includes(k) ? Math.max(k === 'minBuyers' ? 1 : 0, Number(e.target.value) || 0) : e.target.value;
      if (k === 'minBuyers') filters[k] = Math.floor(filters[k]);
      try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* keep session settings */ }
      revision++; paint(true);
    });
    list.addEventListener('click', e => {
      pointerBusy = false;
      const toggle = e.target.closest('[data-expand]');
      if (toggle) { const key = toggle.dataset.expand; expanded.has(key) ? expanded.delete(key) : expanded.add(key); paint(true); }
      else navigate(e);
    });
    list.addEventListener('error', e => {
      if (e.target.matches?.('.gdh-buy-person img')) e.target.hidden = true;
    }, true);
    return el;
  }
  const mountBody = el => { if (el) { if (!body) body = makeBody(); if (body.parentNode !== el) el.appendChild(body); paint(true); } };
  function ensureRoot() {
    const d = discover(); if (!d) return false;
    if (!root) {
      rootHost = document.createElement('div'); rootHost.className = 'gdh-buy-monitor-root'; document.body.appendChild(rootHost);
      class Boundary extends d.React.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        componentDidCatch() { mountingError = '原生面板接口已变化，请关闭后重试'; setOwnState(old => ({ ...old, visible: false })); }
        render() { return this.state.failed ? null : this.props.children; }
      }
      deps.Boundary = Boundary;
      root = d.dom.createRoot(rootHost);
    }
    return true;
  }
  function syncRoot() {
    const next = readProviders(); if (!next) return;
    const state = next.rnd.stateData?.[ID] || defaultState();
    if (active !== !!state.visible) { active = !!state.visible; started ||= active; notifyVisibility(); }
    if (button) {
      button.setAttribute('aria-pressed', String(active));
      button.title = mountingError || '聚合监控：点击打开，原生拖拽 / 缩放 / 停靠';
    }
    if (!started || !ensureRoot()) return;
    if (context && context.providers.length === next.providers.length && context.providers.every((p, i) => p.type === next.providers[i].type && p.value === next.providers[i].value)) return;
    context = next;
    const { React: R, Rnd, Boundary } = deps;
    let tree = R.createElement(Boundary, { key: mountingError ? 'failed' : 'ready' }, R.createElement(Rnd, {
      rndViewData: state, setRndViewData: setOwnState, dragId: ID, enableAttach: true,
      minWidth: 290, maxWidth: 720, enableClose: true, className: 'gdh-buy-native-shell',
      dragHandleTestId: 'gdh-buy-monitor-drag', closeIconClassName: '!top-[12px]',
    }, R.createElement('div', { className: 'gdh-buy-monitor-mount', ref: mountBody })));
    for (const p of next.providers) tree = R.createElement(p.type.Provider || p.type, { value: p.value }, tree);
    root.render(tree);
  }
  function ensureButton() {
    if (button?.isConnected) return;
    const anchor = document.querySelector('[data-testid="holding-float-toggle"]')
      || document.querySelector('[data-sentry-source-file="FootButton.tsx"]');
    if (!anchor?.parentElement) return;
    if (!button) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'gdh-buy-monitor-tab';
      button.textContent = '◉ 聚合监控'; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (!readProviders() || !discover()) { button.title = '尚未找到 GMGN 原生面板，请等待页面加载'; return; }
        mountingError = ''; context = null;
        setOwnState(old => ({ ...old, visible: !old.visible }));
      });
    }
    anchor.before(button);
  }
  function nativeEvent(hit) {
    return { source: 'gmgn', chain: hit.chain, type: hit.side, wallet: hit.maker || hit.maker_info?.address,
      // Verified against GMGN's Tracker filter mapping: sell {0: sell_part, 1: sell_all}.
      // BSC processed events are provisional, just as in GMGN's own filter.
      closed: hit.side === 'sell' && !(hit.chain === 'bsc' && hit.commitment === 'processed')
        && [0, 1].includes(hit.is_open_or_close) ? hit.is_open_or_close === 1 : null,
      addr: hit.base_address || hit.base_token?.address,
      name: hit.maker_info?.twitter_name || hit.twitter_name || hit.maker_info?.twitter_username || hit.twitter_username || hit.maker_info?.name || hit.nick_name,
      avatar: hit.avatar || hit.maker_info?.avatar,
      symbol: hit.base_symbol || hit.base_token?.symbol, img: hit.base_logo || hit.base_token?.logo,
      quote: hit.base_token?.quote_symbol || hit.quote_symbol,
      ts: hit.timestamp, tx: hit.transaction_hash || hit.tx_hash, key: hit.uniqKey || hit.id,
      usd: positive(hit.amount_usd) || positive(hit.cost_usd),
      mc: positive(hit.price_usd) * positive(hit.base_total_supply || hit.base_token?.total_supply) };
  }
  function collectNative() {
    const node = document.querySelector('[data-sentry-component="TrackingBody"]');
    let start = currentFiber(node); if (!start) return false;
    const stack = [{ f: start, depth: 0 }], seen = new Set(); let visited = 0;
    while (stack.length && visited++ < 500) {
      const { f, depth } = stack.pop(); if (!f || seen.has(f) || depth > 25) continue; seen.add(f);
      const data = f.memoizedProps?.data;
      if (Array.isArray(data) && data.length && data[0]?.base_address && data[0]?.maker) {
        if (!dataArrays.has(data)) { dataArrays.add(data); engine.ingest(data.slice(0, 2500).map(nativeEvent)); revision++; }
        // The virtual list already contains the complete loaded data; avoid visiting every rendered row.
        continue;
      }
      if (f !== start && f.sibling) stack.push({ f: f.sibling, depth });
      if (f.child) stack.push({ f: f.child, depth: depth + 1 });
    }
    return true;
  }
  function paint(force = false) {
    if (!active || pointerBusy || !body?.isConnected || !force && Date.now() - lastPaint < 1000) return;
    const now = Date.now(); lastPaint = now;
    const result = engine.snapshot(filters, now);
    const tracking = !!document.querySelector('[data-sentry-component="TrackingBody"]');
    const statusText = `${result.rows.length} 个代币 · ${tracking ? '追踪已连接' : '追踪面板未打开，保留已接收数据'}${result.capped ? ' · 已达缓存上限' : ''}`;
    if (status.textContent !== statusText) status.textContent = statusText;
    const chainSelect = controls.querySelector('[data-filter="chain"]');
    const chains = new Set(engine.snapshot({ ...filters, chain: '', minBuyers: 1, minUsd: 0 }).rows.map(r => r.chain));
    if (filters.chain) chains.add(filters.chain);
    for (const chain of [...chains].sort()) if (![...chainSelect.options].some(o => o.value === chain)) chainSelect.add(new Option(chain.toUpperCase(), chain));
    chainSelect.value = filters.chain;
    let chainColors = {};
    try { chainColors = JSON.parse(localStorage.getItem('follow_toast_chain_color_v1') || '{}'); } catch { /* use tracking defaults */ }
    const html = result.rows.slice(0, 200).map(row => {
      const href = `/${row.chain}/token/${row.token}`;
      const buyers = row.buyers.map(b => displayBuyer(b, row.chain));
      const people = row.people.map(b => displayBuyer(b, row.chain));
      const closedText = row.unknownCloseCount ? row.closedCount ? `${row.closedCount}+` : '—' : String(row.closedCount);
      const closedHint = alertText(`Confirmed exits: ${row.closedCount}; unknown status: ${row.unknownCloseCount}. Latest received trade in this window; a rebuy removes the exit.`,
        `已确认清仓 ${row.closedCount} 人，状态未知 ${row.unknownCloseCount} 人；按窗口内最新已接收交易判断，重新买入后移除清仓。`);
      const netHint = alertText(`Buy USD minus sell USD, not profit. Missing USD: ${row.unknownAmounts} buys / ${row.unknownSellAmounts} sells.`,
        `买入 USD 减卖出 USD，不是利润；缺少金额：${row.unknownAmounts} 笔买入 / ${row.unknownSellAmounts} 笔卖出。`);
      const details = expanded.has(row.key) ? `<div class="gdh-buy-people">${people.slice(0, 100).map(b => `<div class="gdh-buy-person-detail" title="${esc(b.id)}"><span>${esc(b.name)}</span><small>${[...b.sources].join(' / ').toUpperCase()}${b.closed === true ? ` · ${alertText('Closed', '清仓')}` : b.sellCount && b.closed === null ? ` · ${alertText('Exit unknown', '清仓未知')}` : ''}</small><b title="${alertText('Bought', '买入')}">${flowMoney(b.usd, b.unknownAmounts)}</b>
        <aside><span>${alertText('Sold', '卖出')} <i class="gdh-buy-negative">${flowMoney(b.sellUsd, b.unknownSellAmounts)}</i></span><span>${alertText('Net buy', '净买入')} <i class="${b.usd >= b.sellUsd ? 'gdh-buy-positive' : 'gdh-buy-negative'}">${netMoney(b.usd - b.sellUsd, !b.unknownAmounts && !b.unknownSellAmounts)}</i></span></aside></div>`).join('')}</div>` : '';
      const avatars = `<button type="button" class="gdh-buy-avatars" data-expand="${esc(row.key)}" aria-label="查看买入者头像和明细" title="${row.buyerCount} 位买家，点击查看明细">${buyers.slice(0, 5).map(b => `<span class="gdh-buy-person" title="${esc(b.name)} · ${money(b.usd)}"><span aria-hidden="true">${esc(Array.from(b.name || '?')[0])}</span>${b.avatar ? `<img src="${esc(b.avatar)}" loading="lazy" alt="${esc(b.name)}">` : ''}</span>`).join('')}</button>`;
      return `<article style="--gdh-buy-chain-color:${esc(chainColor(row.chain, chainColors))}"><div class="gdh-buy-row"><button type="button" data-expand="${esc(row.key)}" aria-expanded="${expanded.has(row.key)}" aria-label="展开买家">${expanded.has(row.key) ? '⌄' : '›'}</button>
        <a data-aggregate-token href="${href}">${row.img ? `<img src="${esc(row.img)}" loading="lazy" alt="">` : '<span class="gdh-buy-avatar">●</span>'}<strong>${esc(row.symbol || row.token.slice(0, 8))}</strong><small>${esc(row.chain.toUpperCase())}</small></a>
        ${avatars}<button type="button" data-expand="${esc(row.key)}" class="gdh-buy-count" title="去重买家 / 账号，点击查看明细">♙ ${row.buyerCount}</button></div>
        <div class="gdh-buy-metrics"><span>市值 <b>${money(Number(row.mc))}</b>${row.quote ? ` <i>${esc(row.quote)}</i>` : ''}</span><span>买入 <b class="gdh-buy-positive">${money(row.buyUsd)}${row.unknownAmounts ? '+' : ''}</b></span></div>
        <div class="gdh-buy-flow"><span>${alertText('Sold', '卖出')}<b class="gdh-buy-negative" data-flow="sell">${flowMoney(row.sellUsd, row.unknownSellAmounts)}</b></span><span title="${esc(netHint)}">${alertText('Net buy', '净买入')}<b class="${row.netComplete ? row.netUsd > 0 ? 'gdh-buy-positive' : row.netUsd < 0 ? 'gdh-buy-negative' : '' : ''}" data-flow="net">${netMoney(row.netUsd, row.netComplete)}</b></span><button type="button" data-expand="${esc(row.key)}" title="${esc(closedHint)}">${alertText('Closed', '清仓')}<b data-flow="closed">${closedText}</b></button></div>
        <div class="gdh-buy-meta"><span>${row.sources.join(' / ').toUpperCase()} · ${row.buyCount} 笔买入 / ${row.sellCount} 笔卖出</span><span>${Math.max(0, Math.floor((now - row.lastTs) / 60000))}m 前</span></div>${details}</article>`;
    }).join('') || '<div class="gdh-buy-empty">暂无符合条件的聚合买入<br><small>等待追踪 / FOMO / Pump 推送，或调整人数、金额和时间窗口</small></div>';
    // Compare our rendering fingerprint, not browser-normalized innerHTML (quotes
    // in text nodes are serialized differently). Do not replace a pressed link.
    if (lastListHtml !== html) { list.innerHTML = html; lastListHtml = html; }
    paintedRevision = revision;
  }
  document.addEventListener('gdh-buy-aggregate-feeds', () => {
    const raw = document.documentElement.getAttribute(ATTR); document.documentElement.removeAttribute(ATTR);
    if (!started || !raw || raw.length > 2_000_000) return;
    try {
      const packet = JSON.parse(raw); sourceFlags = packet.enabled || sourceFlags;
      for (const s of ['fomo', 'pump']) {
        if (packet.reset === true || Array.isArray(packet.reset) && packet.reset.includes(s)) engine.removeSource(s);
        if (sourceFlags[s] === false) engine.removeSource(s);
        else engine.ingest((Array.isArray(packet[s]) ? packet[s] : []).map(e => ({ ...e, source: s })));
      }
      revision++;
    } catch { /* untrusted bridge data */ }
  });
  const releasePointer = () => { setTimeout(() => { pointerBusy = false; }, 0); };
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  window.addEventListener('blur', releasePointer);
  window.addEventListener('storage', e => {
    if (e.key !== ALERT_KEY) return;
    try { soundConfig = alertSettings(JSON.parse(e.newValue)) || alertSettings(); } catch { soundConfig = alertSettings(); }
    sound.stop(); resetAlerts();
    // Leave an unsaved form alone; make the external change explicit instead of silently overwriting drafts.
    const msg = body?.querySelector('[data-alert-message]');
    if (msg) msg.textContent = alertText('Settings changed in another tab. Revert edits to load the latest values.', '另一标签页已修改设置，请恢复已保存以读取最新值。');
  });
  notifyVisibility();
  // Bounded, visible-page-only maintenance. No whole-document mutation scanner or new fetch loop.
  setInterval(() => {
    const visible = document.visibilityState !== 'hidden';
    if (!visible && !(soundConfig.enabled && sound.ready())) return;
    if (visible) { ensureButton(); syncRoot(); }
    if (started && Date.now() >= nextScan) { nextScan = Date.now() + 1000; collectNative(); }
    checkAlerts();
    if (visible && active) { refreshWalletMarks(); paint(paintedRevision !== revision); }
  }, 500);
})();
