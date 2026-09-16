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
          events.set(e.key, old ? { ...old, ...e, usd: e.usd || old.usd, mc: e.mc || old.mc,
            name: e.nameRank >= old.nameRank ? e.name : old.name, nameRank: Math.max(e.nameRank, old.nameRank),
            img: e.img || old.img, avatar: e.avatar || old.avatar, symbol: e.symbol || old.symbol, quote: e.quote || old.quote } : e);
        }
        prune(now);
      },
      removeSource(source) { for (const [key, e] of events) if (e.source === source) events.delete(key); },
      clear() { events.clear(); capped = false; },
      snapshot(options = {}, now = Date.now()) {
        prune(now);
        const windowMs = [300_000, 900_000, 3_600_000, DAY].includes(Number(options.windowMs)) ? Number(options.windowMs) : 300_000;
        const relevant = [...events.values()].filter(e => e.ts >= now - windowMs && (!options.chain || options.chain === e.chain));
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
              if (e.nameRank > old.nameRank || e.nameRank === old.nameRank && e.ts >= old.ts) {
                old.name = e.name; old.nameRank = e.nameRank;
              }
            }
            else trades.set(id, { ...e, buyer, sources: new Set([e.source]) });
          }
          const buyers = new Map(); const sources = new Set();
          let buyUsd = 0, sellUsd = 0, buyCount = 0, sellCount = 0, unknownAmounts = 0;
          for (const t of trades.values()) {
            if (t.side === 'buy') {
              buyCount++; buyUsd += t.usd; if (!t.usd) unknownAmounts++;
              if (!buyers.has(t.buyer)) buyers.set(t.buyer, { id: t.buyer, name: '', nameRank: -1, nameTs: 0, avatar: '', avatarTs: 0, usd: 0, count: 0, sources: new Set() });
              const b = buyers.get(t.buyer); b.usd += t.usd; b.count++;
              if (t.nameRank > b.nameRank || t.nameRank === b.nameRank && t.ts >= b.nameTs) {
                b.name = t.name; b.nameRank = t.nameRank; b.nameTs = t.ts;
              }
              if (t.avatar && t.ts >= b.avatarTs) { b.avatar = t.avatar; b.avatarTs = t.ts; }
              for (const s of t.sources) { sources.add(s); b.sources.add(s); }
            } else { sellCount++; sellUsd += t.usd; }
          }
          if (!buyCount) continue;
          const latest = group.slice().sort((a, b) => b.ts - a.ts);
          const meta = field => latest.find(e => e[field])?.[field] || '';
          rows.push({ key, chain: latest[0].chain, token: latest[0].token, symbol: meta('symbol'), img: meta('img'),
            mc: meta('mc'), quote: meta('quote'), lastTs: Math.max(...group.filter(e => e.side === 'buy').map(e => e.ts)),
            buyUsd, sellUsd, buyCount, sellCount, buyerCount: buyers.size, unknownAmounts,
            buyers: [...buyers.values()].sort((a, b) => b.usd - a.usd), sources: [...sources] });
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
  const api = { create, normalize, address };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (location.hostname !== 'gmgn.ai' || window.__gdhBuyMonitor) return;
  window.__gdhBuyMonitor = true;

  const ID = 'GDH_BUY_AGGREGATE_V1';
  const ATTR = 'data-gdh-buy-aggregate-feeds';
  const FILTER_KEY = 'gdhBuyAggregateFiltersV1';
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
  let active = false, started = false, mountingError = '', sourceFlags = { fomo: true, pump: true };
  let dataArrays = new WeakSet(), nextScan = 0, lastPaint = 0, revision = 0, paintedRevision = -1;
  const expanded = new Set();
  let pointerBusy = false, lastListHtml = '';
  let filters = { windowMs: 300_000, minBuyers: 2, minUsd: 0, sort: 'buyerCount', chain: '' };
  try { const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); if (saved && typeof saved === 'object') filters = { ...filters, ...saved }; } catch { /* storage is optional */ }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => n > 0 ? '$' + (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2)) : '—';
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
    document.documentElement.setAttribute('data-gdh-buy-aggregate-active', active ? '1' : '0');
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
      const details = expanded.has(row.key) ? `<div class="gdh-buy-people">${buyers.slice(0, 100).map(b => `<div title="${esc(b.id)}"><span>${esc(b.name)}</span><small>${[...b.sources].join(' / ').toUpperCase()}</small><b>${money(b.usd)}</b></div>`).join('')}</div>` : '';
      const avatars = `<button type="button" class="gdh-buy-avatars" data-expand="${esc(row.key)}" aria-label="查看买入者头像和明细" title="${row.buyerCount} 位买家，点击查看明细">${buyers.slice(0, 5).map(b => `<span class="gdh-buy-person" title="${esc(b.name)} · ${money(b.usd)}"><span aria-hidden="true">${esc(Array.from(b.name || '?')[0])}</span>${b.avatar ? `<img src="${esc(b.avatar)}" loading="lazy" alt="${esc(b.name)}">` : ''}</span>`).join('')}</button>`;
      return `<article style="--gdh-buy-chain-color:${esc(chainColor(row.chain, chainColors))}"><div class="gdh-buy-row"><button type="button" data-expand="${esc(row.key)}" aria-expanded="${expanded.has(row.key)}" aria-label="展开买家">${expanded.has(row.key) ? '⌄' : '›'}</button>
        <a data-aggregate-token href="${href}">${row.img ? `<img src="${esc(row.img)}" loading="lazy" alt="">` : '<span class="gdh-buy-avatar">●</span>'}<strong>${esc(row.symbol || row.token.slice(0, 8))}</strong><small>${esc(row.chain.toUpperCase())}</small></a>
        ${avatars}<button type="button" data-expand="${esc(row.key)}" class="gdh-buy-count" title="去重买家 / 账号，点击查看明细">♙ ${row.buyerCount}</button></div>
        <div class="gdh-buy-metrics"><span>市值 <b>${money(Number(row.mc))}</b>${row.quote ? ` <i>${esc(row.quote)}</i>` : ''}</span><span>买入 <b class="gdh-buy-positive">${money(row.buyUsd)}${row.unknownAmounts ? '+' : ''}</b></span></div>
        <div class="gdh-buy-meta"><span>${row.sources.join(' / ').toUpperCase()} · ${row.buyCount} 笔买入</span><span>${Math.max(0, Math.floor((now - row.lastTs) / 60000))}m 前</span></div>${details}</article>`;
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
  // Bounded, visible-page-only maintenance. No whole-document mutation scanner or new fetch loop.
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    ensureButton(); syncRoot();
    if (started && Date.now() >= nextScan) { nextScan = Date.now() + 1000; collectNative(); }
    if (active) { refreshWalletMarks(); paint(paintedRevision !== revision); }
  }, 500);
})();
