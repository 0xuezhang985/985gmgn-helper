(() => {
  'use strict';

  if (window.__gdhBrewStarted) return;
  window.__gdhBrewStarted = true;

  const BREW_FACTORY = '0xeea6c3bfb29fd9a35380438956bae7b109c63d85';
  const CACHE_KEY = 'brewTrenchCacheV1';
  const CACHE_TTL_MS = 2 * 60 * 1000;
  const BREW_AUTO_REFRESH_MS = 2 * 60 * 1000;
  const STALE_CACHE_MS = 24 * 60 * 60 * 1000;
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const DEFAULTS = {
    enableBrewPanel: true,
    brewPanelOpen: false,
    brewPanelTab: 'new',
    brewPanelPos: null,
  };

  let settings = { ...DEFAULTS };
  let panelEl = null;
  let launcherEl = null;
  let cache = null;
  let loading = null;

  const storageGet = (defaults) => new Promise((resolve) => {
    try { chrome.storage.local.get(defaults, resolve); } catch { resolve(defaults); }
  });
  const storageSet = (values) => new Promise((resolve) => {
    try { chrome.storage.local.set(values, resolve); } catch { resolve(); }
  });

  function finiteBrewNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function compactBrewCheckpoint(raw, now = Date.now()) {
    if (!raw || String(raw.factory || '').toLowerCase() !== BREW_FACTORY) return [];
    if (!Array.isArray(raw.tokens)) return [];
    const seen = new Set();
    const items = [];
    for (const token of raw.tokens) {
      const address = String(token?.address || '').toLowerCase();
      const pool = String(token?.pool || '').toLowerCase();
      const launchedAt = Number(token?.launchedAt);
      if (!ADDRESS_RE.test(address) || !ADDRESS_RE.test(pool) || seen.has(address)) continue;
      if (!Number.isFinite(launchedAt) || launchedAt <= 0 || launchedAt > now + 5 * 60 * 1000) continue;
      seen.add(address);
      items.push({
        address,
        pool,
        symbol: String(token?.symbol || '').trim().slice(0, 32) || '—',
        name: String(token?.name || '').trim().slice(0, 64) || '未命名代币',
        quoteSymbol: String(token?.quoteSymbol || '').trim().slice(0, 40) || 'Quote',
        launchedAt,
        description: String(token?.description || '').trim().slice(0, 280),
        imageUrl: /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(String(token?.imageUrl || ''))
          && String(token.imageUrl).length <= 40000 ? String(token.imageUrl) : '',
      });
    }
    return items.sort((a, b) => b.launchedAt - a.launchedAt).slice(0, 300);
  }

  function mergeBrewMarkets(tokens, pairs) {
    const exact = new Map();
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      const pool = String(pair?.pairAddress || '').toLowerCase();
      const base = String(pair?.baseToken?.address || '').toLowerCase();
      if (!ADDRESS_RE.test(pool) || !ADDRESS_RE.test(base)) continue;
      exact.set(`${pool}|${base}`, pair);
    }
    return (Array.isArray(tokens) ? tokens : []).map((token) => {
      const pair = exact.get(`${token.pool}|${token.address}`);
      const marketCap = finiteBrewNumber(pair?.marketCap);
      const fdv = finiteBrewNumber(pair?.fdv);
      return {
        ...token,
        indexed: Boolean(pair),
        priceUsd: finiteBrewNumber(pair?.priceUsd),
        marketCapUsd: marketCap ?? fdv,
        marketCapKind: marketCap != null ? 'MC' : fdv != null ? 'FDV' : '',
        volume24hUsd: finiteBrewNumber(pair?.volume?.h24),
        liquidityUsd: finiteBrewNumber(pair?.liquidity?.usd),
        change24h: Number.isFinite(Number(pair?.priceChange?.h24)) ? Number(pair.priceChange.h24) : null,
        buys24h: finiteBrewNumber(pair?.txns?.h24?.buys),
        sells24h: finiteBrewNumber(pair?.txns?.h24?.sells),
        dexId: String(pair?.dexId || '').slice(0, 30),
        dexLabel: Array.isArray(pair?.labels) ? String(pair.labels[0] || '').slice(0, 30) : '',
      };
    });
  }

  function sortBrewItems(items, tab) {
    const list = [...(Array.isArray(items) ? items : [])];
    const numberOrBottom = (value) => (Number.isFinite(value) ? value : -1);
    if (tab === 'hot') {
      return list.sort((a, b) => numberOrBottom(b.volume24hUsd) - numberOrBottom(a.volume24hUsd)
        || numberOrBottom(b.liquidityUsd) - numberOrBottom(a.liquidityUsd)
        || b.launchedAt - a.launchedAt);
    }
    if (tab === 'market') {
      return list.sort((a, b) => numberOrBottom(b.marketCapUsd) - numberOrBottom(a.marketCapUsd)
        || numberOrBottom(b.liquidityUsd) - numberOrBottom(a.liquidityUsd)
        || b.launchedAt - a.launchedAt);
    }
    return list.sort((a, b) => b.launchedAt - a.launchedAt);
  }

  function requestBrewTrenches(force = false) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'brew-trenches', force: force === true }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) return reject(new Error(runtimeError.message || '后台连接失败'));
          if (!response?.ok || !response?.checkpoint || !Array.isArray(response?.pairs)) {
            return reject(new Error(response?.message || 'Brew 数据暂时不可用'));
          }
          return resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async function hydrateBrewCache() {
    if (cache) return;
    const stored = await storageGet({ [CACHE_KEY]: null });
    const candidate = stored[CACHE_KEY];
    if (candidate && Array.isArray(candidate.items)
      && Date.now() - Number(candidate.fetchedAt || 0) < STALE_CACHE_MS) {
      cache = candidate;
    }
  }

  async function loadBrewData(force = false) {
    await hydrateBrewCache();
    if (!force && cache && Date.now() - Number(cache.fetchedAt || 0) < CACHE_TTL_MS) return cache;
    if (loading) return loading;
    loading = (async () => {
      const response = await requestBrewTrenches(force);
      const checkpoint = response.checkpoint;
      const tokens = compactBrewCheckpoint(checkpoint);
      if (!tokens.length) throw new Error('Brew 官方发行快照暂时为空');
      const pairs = response.pairs;
      const next = {
        fetchedAt: Date.now(),
        localSource: response.localSource === true,
        marketPartial: response.marketPartial === true,
        launchPartial: response.launchPartial === true,
        complete: checkpoint?.complete === true,
        total: Number(checkpoint?.total) || tokens.length,
        indexed: pairs.length,
        items: mergeBrewMarkets(tokens, pairs),
      };
      cache = next;
      storageSet({ [CACHE_KEY]: next });
      return next;
    })().finally(() => { loading = null; });
    return loading;
  }

  function money(value) {
    if (!Number.isFinite(value)) return '—';
    if (value > 0 && value < 0.01) return `$${value.toPrecision(3)}`;
    return new Intl.NumberFormat('en-US', {
      notation: value >= 1000 ? 'compact' : 'standard',
      maximumFractionDigits: value >= 1000 ? 2 : 4,
    }).format(value).replace(/^/, '$');
  }

  function ageText(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  function shortAddress(address) {
    return `${String(address).slice(0, 6)}…${String(address).slice(-4)}`;
  }

  function createText(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function brewTokenPath(address) {
    if (!ADDRESS_RE.test(String(address || ''))) return '';
    if (location.hostname === 'gmgn.ai') return `/bsc/token/${address}`;
    if (location.hostname === 'debot.ai') return `/token/bsc/${address}`;
    return '';
  }

  function brewSpaNavigate(path) {
    if (!path || location.pathname === path) return;
    if (location.hostname !== 'gmgn.ai') {
      location.assign(path);
      return;
    }
    try {
      document.documentElement.setAttribute('data-gdh-nav', path);
      document.dispatchEvent(new Event('gdh-navigate'));
    } catch {
      location.assign(path);
      return;
    }
    window.setTimeout(() => {
      if (location.pathname !== path) location.assign(path);
    }, 450);
  }

  function renderBrewRow(item) {
    const row = document.createElement('article');
    row.className = 'gdh-brew__row';
    row.tabIndex = 0;
    row.title = `在当前站点打开代币：${item.address}`;
    const openToken = () => {
      const path = brewTokenPath(item.address);
      if (path) brewSpaNavigate(path);
    };
    row.addEventListener('click', openToken);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openToken();
      }
    });

    const avatar = createText('span', 'gdh-brew__avatar', Array.from(item.symbol).slice(0, 2).join('').toUpperCase());
    if (item.imageUrl) {
      const image = document.createElement('img');
      image.src = item.imageUrl;
      image.alt = item.name;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => image.remove(), { once: true });
      avatar.appendChild(image);
    }
    const body = document.createElement('div');
    body.className = 'gdh-brew__body';
    const head = document.createElement('div');
    head.className = 'gdh-brew__head';
    const identity = document.createElement('div');
    identity.className = 'gdh-brew__identity';
    identity.append(
      createText('strong', 'gdh-brew__symbol', item.symbol),
      createText('span', 'gdh-brew__name', item.name),
    );
    head.append(identity, createText('time', 'gdh-brew__age', ageText(item.launchedAt)));

    const metrics = document.createElement('div');
    metrics.className = 'gdh-brew__metrics';
    const price = createText('span', 'gdh-brew__metric', Number.isFinite(item.priceUsd)
      ? `价格 ${money(item.priceUsd)}` : '价格 —');
    const cap = createText('span', 'gdh-brew__metric', item.marketCapKind
      ? `${item.marketCapKind} ${money(item.marketCapUsd)}` : '市值待收录');
    const volume = createText('span', 'gdh-brew__metric', Number.isFinite(item.volume24hUsd)
      ? `24h ${money(item.volume24hUsd)}` : '24h —');
    metrics.append(price, cap, volume);
    if (Number.isFinite(item.change24h)) {
      const change = createText('span', `gdh-brew__change ${item.change24h >= 0 ? 'is-up' : 'is-down'}`,
        `${item.change24h >= 0 ? '+' : ''}${item.change24h.toFixed(Math.abs(item.change24h) >= 100 ? 0 : 2)}%`);
      metrics.appendChild(change);
    }

    const pool = document.createElement('a');
    pool.className = 'gdh-brew__pool';
    pool.href = `https://dexscreener.com/bsc/${item.pool}`;
    pool.target = '_blank';
    pool.rel = 'noreferrer';
    pool.title = `官方 Brew 底池 ${item.pool} · 在 DexScreener 打开`;
    pool.addEventListener('click', (event) => event.stopPropagation());
    const pairName = `${item.symbol}/${item.quoteSymbol}`;
    const dexName = [item.dexId, item.dexLabel].filter(Boolean).join(' ');
    pool.append(
      createText('span', 'gdh-brew__pool-main', `池 ${pairName} · ${shortAddress(item.pool)}`),
      createText('span', 'gdh-brew__pool-liq', Number.isFinite(item.liquidityUsd)
        ? `LP ${money(item.liquidityUsd)}${dexName ? ` · ${dexName}` : ''}`
        : '行情待收录'),
    );
    body.append(head, metrics, pool);
    row.append(avatar, body);
    return row;
  }

  function renderBrewPanel(state = {}) {
    if (!panelEl) return;
    const list = panelEl.querySelector('.gdh-brew__list');
    const status = panelEl.querySelector('.gdh-brew__status');
    if (!list || !status) return;
    if (state.loading && !cache) {
      status.textContent = '正在读取 Brew 官方发行与底池…';
      list.replaceChildren(createText('div', 'gdh-brew__empty', '加载中…'));
      return;
    }
    if (state.error && !cache) {
      status.textContent = '加载失败';
      const error = createText('div', 'gdh-brew__empty is-error', String(state.error));
      const retry = createText('button', 'gdh-brew__retry', '重试');
      retry.type = 'button';
      retry.addEventListener('click', () => refreshBrewPanel(true));
      error.appendChild(retry);
      list.replaceChildren(error);
      return;
    }
    if (!cache?.items?.length) return;
    const sorted = sortBrewItems(cache.items, settings.brewPanelTab);
    const indexedCount = cache.items.filter((item) => item.indexed).length;
    const stale = state.error ? ' · 行情刷新失败，显示缓存' : '';
    const local = cache.localSource ? ' · 本地 GMGN 行情' : '';
    const partial = cache.marketPartial ? ' · 部分行情待收录' : '';
    const launchPartial = cache.launchPartial ? ' · 新发行同步中' : '';
    const updated = Number(cache.fetchedAt) > 0
      ? ` · 更新 ${new Date(cache.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '';
    status.textContent = `${cache.items.length} 个代币 · ${indexedCount} 个官方池已收录${local}${partial}${launchPartial}${updated}${stale}`;
    const fragment = document.createDocumentFragment();
    sorted.forEach((item) => fragment.appendChild(renderBrewRow(item)));
    list.replaceChildren(fragment);
  }

  async function refreshBrewPanel(force = false) {
    renderBrewPanel({ loading: true });
    try {
      await loadBrewData(force);
      renderBrewPanel();
    } catch (error) {
      renderBrewPanel({ error: error?.message || '请求失败' });
    }
  }

  function setPanelPosition(panel) {
    const pos = settings.brewPanelPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 140, pos.x))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 70, pos.y))}px`;
      panel.style.right = 'auto';
      return;
    }
    panel.style.right = '18px';
    panel.style.top = '82px';
  }

  function makePanelDraggable(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(window.innerWidth - 140, drag.left + event.clientX - drag.x));
      const top = Math.max(0, Math.min(window.innerHeight - 70, drag.top + event.clientY - drag.y));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    });
    const finish = () => {
      if (!drag) return;
      drag = null;
      const rect = panel.getBoundingClientRect();
      settings.brewPanelPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
      storageSet({ brewPanelPos: settings.brewPanelPos });
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  function buildBrewPanel() {
    const panel = document.createElement('section');
    panel.className = 'gdh-brew-panel';
    panel.setAttribute('aria-label', 'Brew 战壕');
    const bar = document.createElement('header');
    bar.className = 'gdh-brew__bar';
    bar.appendChild(createText('strong', 'gdh-brew__title', '🍺 Brew 战壕'));
    const tabs = document.createElement('nav');
    tabs.className = 'gdh-brew__tabs';
    [['new', '新创建'], ['hot', '热门'], ['market', '市值']].forEach(([id, label]) => {
      const button = createText('button', `gdh-brew__tab${settings.brewPanelTab === id ? ' is-active' : ''}`, label);
      button.type = 'button';
      button.dataset.tab = id;
      button.title = id === 'hot' ? '按官方 Brew 底池 24h 成交额排序' : '';
      button.addEventListener('click', () => {
        settings.brewPanelTab = id;
        storageSet({ brewPanelTab: id });
        panel.querySelectorAll('.gdh-brew__tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === id));
        renderBrewPanel();
      });
      tabs.appendChild(button);
    });
    const reload = createText('button', 'gdh-brew__icon', '↻');
    reload.type = 'button';
    reload.title = '刷新官方发行与底池行情';
    reload.addEventListener('click', () => refreshBrewPanel(true));
    const close = createText('button', 'gdh-brew__icon', '×');
    close.type = 'button';
    close.title = '关闭浮窗';
    close.addEventListener('click', () => setBrewOpen(false));
    bar.append(tabs, reload, close);
    const status = createText('div', 'gdh-brew__status', '准备加载…');
    const list = document.createElement('div');
    list.className = 'gdh-brew__list';
    panel.append(bar, status, list);
    makePanelDraggable(panel, bar);
    return panel;
  }

  function setBrewOpen(open) {
    settings.brewPanelOpen = Boolean(open);
    storageSet({ brewPanelOpen: settings.brewPanelOpen });
    syncBrewUi();
  }

  function syncBrewUi() {
    if (settings.enableBrewPanel === false) {
      launcherEl?.remove();
      panelEl?.remove();
      launcherEl = null;
      panelEl = null;
      return;
    }
    if (!launcherEl || !document.contains(launcherEl)) {
      launcherEl = createText('button', 'gdh-brew-launcher', '🍺 Brew');
      launcherEl.classList.toggle('is-debot', location.hostname === 'debot.ai');
      launcherEl.type = 'button';
      launcherEl.title = '打开 Brew 战壕';
      launcherEl.addEventListener('click', () => setBrewOpen(!settings.brewPanelOpen));
      document.body.appendChild(launcherEl);
    }
    launcherEl.classList.toggle('is-active', settings.brewPanelOpen === true);
    if (!settings.brewPanelOpen) {
      panelEl?.remove();
      panelEl = null;
      return;
    }
    if (!panelEl || !document.contains(panelEl)) {
      panelEl = buildBrewPanel();
      document.body.appendChild(panelEl);
      setPanelPosition(panelEl);
      refreshBrewPanel(false);
    }
  }

  storageGet(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    if (!['new', 'hot', 'market'].includes(settings.brewPanelTab)) settings.brewPanelTab = 'new';
    syncBrewUi();
  });

  window.setInterval(() => {
    if (settings.brewPanelOpen && document.visibilityState === 'visible') refreshBrewPanel(true);
  }, BREW_AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (settings.brewPanelOpen && document.visibilityState === 'visible'
      && (!cache || Date.now() - Number(cache.fetchedAt || 0) >= BREW_AUTO_REFRESH_MS)) refreshBrewPanel(true);
  });

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.enableBrewPanel) return;
      settings.enableBrewPanel = changes.enableBrewPanel.newValue !== false;
      syncBrewUi();
    });
  } catch {
    // 扩展重载时旧页面上下文会失效；新脚本会重新初始化。
  }
})();
