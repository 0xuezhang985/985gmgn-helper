'use strict';

(() => {
  if (location.hostname !== 'debot.ai') return;

  const DEFAULTS = {
    enabled: true,
    enableFomoPanel: true,
    enableFomoFeed: true,
    enablePumpFeed: true,
    fomoTranslate: true,
    fomoFeedChainOnly: false,
    fomoFeedTypes: {
      buy: true, sell: true, swap: true, thesis: true, transferIn: true, refund: true,
    },
    enableSpecialWallet: true,
    specialWallets: [],
    blockedTokens: [],
    debotFomoPanelOpen: false,
    debotFomoPanelFolded: false,
    debotFomoPanelPos: null,
  };
  const FOMO_NETWORK_ID = {
    bsc: 56, eth: 1, base: 8453, sol: 1399811149, robinhood: 4663, monad: 143,
  };
  const FOMO_CHAIN_SLUG = {
    bsc: 'bnb', eth: 'eth', base: 'base', sol: 'sol', robinhood: 'robinhood', monad: 'monad',
  };
  const FEED_TAGS = {
    buy: { label: '买入', cls: 'is-buy' },
    sell: { label: '卖出', cls: 'is-sell' },
    swap: { label: '换仓', cls: 'is-swap' },
    thesis: { label: '观点', cls: 'is-thesis' },
    transferIn: { label: '转入', cls: 'is-transfer' },
    refund: { label: '退款/失败', cls: 'is-refund' },
  };
  const CHAIN_COLORS = {
    sol: '#7b44f2', bsc: '#eab204', base: '#3073ff', eth: '#4d84f7', robinhood: '#9fc700',
    stable: '#007b4f', arc: '#5c8de5', xlayer: '#4a4a4a', hyperevm: '#55c6ab',
    megaeth: '#2a2a2a', monad: '#6a52f1',
  };
  const PUMP_DEFAULT_TOKEN_FILTERS = [
    'SPCXB', 'SKHYB', 'SPYB', 'XAUT', 'QQQB', 'NVDAB', 'AAPLB', 'TSLAB',
    'MSFTB', 'GOOGLB', 'HOODB', 'BABAB', 'GMEB', 'NFLXB', 'MSTRB', 'DJTB',
  ];
  const FEED_POLL_MS = 18000;
  const FEED_ROW_HEIGHT = 46;
  const FEED_RENDER_CAP = 40;
  const FEED_VISIBLE_CAP = 12;
  const FEED_HEAD_CAP = 6;
  const SIDEBAR_FEED_VISIBLE_CAP = 8;
  const SIDEBAR_FEED_HEAD_CAP = 3;
  const PANEL_REFRESH_MS = 30000;
  const SPECIAL_COLOR_PALETTE = [
    '#f5b83d', '#ef5350', '#43c07a', '#4c9ffe', '#b48ae0', '#ed6ba4', '#3ec6c6',
  ];
  const SPECIAL_PIN_MS = 10000;
  const SPECIAL_PIN_MAX = 3;
  const SPECIAL_PIN_SEEN_MAX = 400;

  let settings = { ...DEFAULTS };
  let fomoEvents = [];
  let pumpEvents = [];
  let pumpDefaultWallets = new Set();
  let monitorFomo = { muted: new Set(), prefs: {} };
  let monitorPump = {
    muted: new Set(), prefs: {}, watch: new Set(), filters: {},
    tokenFilters: new Set(PUMP_DEFAULT_TOKEN_FILTERS), onlyMine: true, globalTradeMinUsd: 10,
  };
  let feedLastFomoAt = 0;
  let feedLastPumpAt = 0;
  let feedRenderRaf = 0;
  let feedPollTimer = 0;
  let feedObserver = null;
  const feedCards = new Map();
  const sidebarFeedCards = new Map();
  const feedSeen = new Set();
  let specialWalletMap = new Map();
  let specialManageOpen = false;
  let specialPalette = null;
  let specialPinStrip = null;
  let specialPinBaselineDone = false;
  const specialPinSeen = new Set();

  let panel = null;
  let panelLauncher = null;
  let panelTab = 'holders';
  let panelLoadedKey = '';
  let panelLoading = false;
  let panelTimer = 0;
  let panelItems = [];
  let panelStats = { key: '', holders: null, thesisCount: null, supply: 0 };
  let pnlObserver = null;
  let pnlActive = 0;
  const pnlQueue = [];
  const pnlCache = new Map();
  const translationCache = new Map();
  const debotSupplyCache = new Map();
  const translators = new Map();
  const translationPendingLangs = new Set();
  let translationDetector = null;
  let translationNeedsGesture = false;
  let translationGesture = false;
  let debotRwaCatalog = new Map();
  let debotRwaCatalogReady = false;
  let debotRwaCatalogLoading = false;
  let debotRwaCatalogRetryAt = 0;
  let debotRwaPopover = null;
  let debotRwaPopoverAnchor = null;
  let debotRwaScanRaf = 0;

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) resolve({ ok: false, reason: 'runtime' });
          else resolve(response || { ok: false, reason: 'empty' });
        });
      } catch {
        resolve({ ok: false, reason: 'runtime' });
      }
    });
  }

  function safeText(value, max = 160) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  function safeMultilineText(value, max = 1500) {
    return String(value ?? '').replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim().slice(0, max);
  }

  function validImageUrl(value) {
    const text = safeText(value, 500);
    return /^https?:\/\//i.test(text) ? text : '';
  }

  function normalizeAddress(value) {
    const text = safeText(value, 96);
    return /^0x[a-fA-F0-9]+$/.test(text) ? text.toLowerCase() : text;
  }

  function fomoUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const number = abs >= 1e9 ? `${(abs / 1e9).toFixed(1)}B`
      : abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
        : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K`
          : abs.toFixed(abs >= 10 ? 0 : 2);
    return `${n < 0 ? '-' : ''}$${number}`;
  }

  function fomoPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  }

  function relativeTime(ts) {
    const diff = Math.max(0, Date.now() - Number(ts));
    if (diff < 60000) return `${Math.max(1, Math.floor(diff / 1000))}s`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  }

  function currentTrackChain() {
    const queryChain = safeText(new URLSearchParams(location.search).get('chain'), 24).toLowerCase();
    return queryChain || debotTokenRoute()?.chain || '';
  }

  function isTrackPage() {
    return location.pathname === '/track'
      && new URLSearchParams(location.search).get('tab') === 'track';
  }

  function isTrackShellPage() {
    return location.pathname === '/track' || debotTokenRoute() !== null;
  }

  /** DeBot 登录后会把 inviteCode 拼成 /token/chain/invite_address。 */
  function debotTokenRoute() {
    const match = location.pathname.match(/^\/token\/([a-z0-9_-]+)\/([^/?#]+)/i);
    if (!match) return null;
    const chain = match[1].toLowerCase();
    if (!(chain in FOMO_NETWORK_ID)) return null;
    let segment;
    try { segment = decodeURIComponent(match[2]); } catch { segment = match[2]; }
    const evm = segment.match(/(0x[a-fA-F0-9]{40})$/);
    const address = evm ? evm[1] : segment.slice(segment.lastIndexOf('_') + 1);
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)
      && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
    return { chain, address, networkId: FOMO_NETWORK_ID[chain] };
  }

  function debotTokenHref(chain, address) {
    const safeChain = safeText(chain, 24).toLowerCase();
    const safeAddress = safeText(address, 96);
    if (!/^[a-z0-9_-]{2,24}$/.test(safeChain) || !safeAddress) return '';
    return `/token/${encodeURIComponent(safeChain)}/${encodeURIComponent(`${debotInvitePrefix()}${safeAddress}`)}`;
  }

  function debotInvitePrefix() {
    const paths = [location.pathname, ...[...document.querySelectorAll('a[href*="/token/"]')]
      .slice(0, 30).map((link) => link.getAttribute('href') || '')];
    for (const path of paths) {
      let pathname = '';
      try { pathname = new URL(path, location.origin).pathname; } catch { continue; }
      const match = pathname.match(/^\/token\/[a-z0-9_-]+\/([^/?#]+)/i);
      if (!match) continue;
      let segment = match[1];
      try { segment = decodeURIComponent(segment); } catch {}
      const token = segment.match(/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/)?.[1] || '';
      const prefix = token ? segment.slice(0, -token.length) : '';
      if (/^[a-zA-Z0-9-]{1,64}_$/.test(prefix)) return prefix;
    }
    return '';
  }

  function bindDebotNavigation(link) {
    if (!(link instanceof HTMLAnchorElement) || link.dataset.gdhDebotNavigate === '1') return link;
    link.dataset.gdhDebotNavigate = '1';
    link.dataset.discover = 'true';
    link.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('button, input, label')) return;
      const href = link.getAttribute('href') || '';
      if (!href) return;
      event.preventDefault();
      document.dispatchEvent(new CustomEvent('gdh-debot-navigate', { detail: { href } }));
    });
    return link;
  }

  // ---- Robinhood 流动池：RWA 资产资料浮窗 ----
  // DeBot 池表的当前代币地址来自页面路由，配对资产地址来自原生代币链接；
  // 两者都必须再与 985monitor RWA 目录的合约和 symbol 同时匹配，避免同名币误标。
  function debotTokenAddressFromHref(href, expectedChain) {
    let url;
    try { url = new URL(String(href || ''), location.origin); } catch { return ''; }
    if (url.origin !== location.origin) return '';
    const match = url.pathname.match(/^\/token\/([a-z0-9_-]+)\/([^/?#]+)/i);
    if (!match || match[1].toLowerCase() !== String(expectedChain || '').toLowerCase()) return '';
    let segment;
    try { segment = decodeURIComponent(match[2]); } catch { segment = match[2]; }
    return segment.match(/(0x[a-fA-F0-9]{40})$/)?.[1].toLowerCase() || '';
  }

  function requestDebotRwaCatalog() {
    if (debotRwaCatalogReady || debotRwaCatalogLoading || Date.now() < debotRwaCatalogRetryAt) return;
    debotRwaCatalogLoading = true;
    chrome.runtime.sendMessage({ type: 'robinhood-rwa-catalog' }, (response) => {
      debotRwaCatalogLoading = false;
      if (chrome.runtime.lastError || !response?.ok || !Array.isArray(response.assets)) {
        debotRwaCatalogRetryAt = Date.now() + 30000;
        return;
      }
      debotRwaCatalog = new Map(response.assets
        .filter((item) => /^0x[a-f0-9]{40}$/.test(String(item?.address || '')))
        .map((item) => [String(item.address).toLowerCase(), item]));
      debotRwaCatalogReady = debotRwaCatalog.size > 0;
      scheduleDebotRwaPoolScan();
    });
  }

  function clearDebotRwaLink(node) {
    if (node === debotRwaPopoverAnchor) closeDebotRwaPopover();
    node.classList.remove('gdh-debot-rwa-link');
    node.removeAttribute('role');
    node.removeAttribute('tabindex');
    node.removeAttribute('title');
    delete node.dataset.gdhDebotRwaAddress;
  }

  function clearDebotRwaPoolLinks(except) {
    document.querySelectorAll('.gdh-debot-rwa-link').forEach((node) => {
      if (!except?.has(node)) clearDebotRwaLink(node);
    });
  }

  function markDebotRwaLink(node, address, asset, kept) {
    if (!(node instanceof HTMLElement)) return;
    const shown = safeText(node.textContent, 32).toUpperCase();
    const expected = safeText(asset?.symbol, 32).toUpperCase();
    if (!shown || shown !== expected) return;
    node.classList.add('gdh-debot-rwa-link');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.dataset.gdhDebotRwaAddress = address;
    node.title = `${asset.symbol} · ${asset.description || 'Robinhood RWA 资产'}\n点击查看资产资料`;
    kept.add(node);
  }

  function scanDebotRwaPoolLinks() {
    const route = debotTokenRoute();
    if (!route || route.chain !== 'robinhood') return void clearDebotRwaPoolLinks();
    requestDebotRwaCatalog();
    if (!debotRwaCatalogReady) return void clearDebotRwaPoolLinks();

    const routeAddress = normalizeAddress(route.address);
    const routeAsset = debotRwaCatalog.get(routeAddress);
    const kept = new Set();
    document.querySelectorAll('tbody tr').forEach((row) => {
      if (!(row instanceof HTMLTableRowElement) || row.cells.length !== 3
        || !row.querySelector('svg.tabler-icon-copy')) return;
      const pairCell = row.cells[0];
      if (routeAsset) {
        const current = [...pairCell.querySelectorAll('[aria-label]')].find((node) => {
          const shown = safeText(node.textContent, 32);
          return shown && shown === safeText(node.getAttribute('aria-label'), 32)
            && !node.closest('a');
        });
        markDebotRwaLink(current, routeAddress, routeAsset, kept);
      }
      pairCell.querySelectorAll('a[href*="/token/"]').forEach((link) => {
        const address = debotTokenAddressFromHref(link.getAttribute('href'), route.chain);
        const asset = debotRwaCatalog.get(address);
        if (asset) markDebotRwaLink(link, address, asset, kept);
      });
    });
    clearDebotRwaPoolLinks(kept);
  }

  function scheduleDebotRwaPoolScan() {
    if (debotRwaScanRaf) return;
    debotRwaScanRaf = window.requestAnimationFrame(() => {
      debotRwaScanRaf = 0;
      try { scanDebotRwaPoolLinks(); } catch { /* 不影响 DeBot 其它增强 */ }
    });
  }

  function formatDebotRwaNumber(value, decimals = 2) {
    const number = value === null || value === undefined || value === '' ? NaN : Number(value);
    if (!Number.isFinite(number)) return '—';
    const absolute = Math.abs(number);
    if (absolute >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
    if (absolute >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
    if (absolute >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
    return number.toLocaleString('en-US', { maximumFractionDigits: decimals });
  }

  function formatDebotRwaMoney(value, price = false) {
    const number = value === null || value === undefined || value === '' ? NaN : Number(value);
    if (!Number.isFinite(number)) return '—';
    return `$${formatDebotRwaNumber(number, price && Math.abs(number) < 1 ? 6 : 2)}`;
  }

  function closeDebotRwaPopover() {
    debotRwaPopover?.remove();
    debotRwaPopover = null;
    debotRwaPopoverAnchor = null;
  }

  function positionDebotRwaPopover() {
    if (!debotRwaPopover) return;
    if (!debotRwaPopoverAnchor?.isConnected) {
      closeDebotRwaPopover();
      return;
    }
    const anchor = debotRwaPopoverAnchor.getBoundingClientRect();
    const popover = debotRwaPopover.getBoundingClientRect();
    const gap = 8;
    let left = anchor.right + gap;
    if (left + popover.width > window.innerWidth - gap) left = anchor.left - popover.width - gap;
    if (left < gap) left = Math.min(window.innerWidth - popover.width - gap, gap);
    const top = Math.min(Math.max(gap, anchor.top), window.innerHeight - popover.height - gap);
    debotRwaPopover.style.left = `${Math.max(gap, left)}px`;
    debotRwaPopover.style.top = `${Math.max(gap, top)}px`;
  }

  function showDebotRwaPopover(anchor, asset) {
    if (debotRwaPopoverAnchor === anchor && debotRwaPopover) {
      closeDebotRwaPopover();
      return;
    }
    closeDebotRwaPopover();
    const popover = document.createElement('section');
    popover.className = 'gdh-debot-rwa-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', `${asset.symbol} RWA 资产资料`);

    const top = document.createElement('div');
    top.className = 'gdh-debot-rwa-popover__top';
    const heading = document.createElement('div');
    const source = document.createElement('div');
    source.className = 'gdh-debot-rwa-popover__source';
    source.textContent = '985monitor · RWA 资产';
    const title = document.createElement('strong');
    title.className = 'gdh-debot-rwa-popover__title';
    title.textContent = asset.symbol;
    heading.append(source, title);
    const close = document.createElement('button');
    close.className = 'gdh-debot-rwa-popover__close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭资产资料');
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeDebotRwaPopover();
    });
    top.append(heading, close);
    popover.append(top);

    if (asset.description) {
      const description = document.createElement('p');
      description.className = 'gdh-debot-rwa-popover__description';
      description.textContent = asset.description;
      popover.append(description);
    }

    const premium = asset.premiumPct === null || asset.premiumPct === undefined
      || asset.premiumPct === '' ? NaN : Number(asset.premiumPct);
    const rows = [
      ['链上价', formatDebotRwaMoney(asset.onchainPrice, true)],
      ['标的价', formatDebotRwaMoney(asset.referencePrice, true)],
      ['溢价', Number.isFinite(premium) ? `${premium > 0 ? '+' : ''}${premium.toFixed(2)}%` : '—', Number.isFinite(premium) ? (premium > 0 ? 'up' : premium < 0 ? 'down' : '') : ''],
      ['流动性', formatDebotRwaMoney(asset.liquidityUsd)],
      ['24h 成交', formatDebotRwaMoney(asset.volume24hUsd)],
      ['链上市值', formatDebotRwaMoney(asset.onchainMarketCapUsd)],
      ['正股市值', formatDebotRwaMoney(asset.referenceMarketCapUsd)],
      ['链上流通量', formatDebotRwaNumber(asset.onchainSupply)],
      ['正股占比', asset.referenceSharePct !== null && asset.referenceSharePct !== undefined
        && asset.referenceSharePct !== '' && Number.isFinite(Number(asset.referenceSharePct))
        ? `${Number(asset.referenceSharePct).toFixed(2)}%` : '—'],
      ['部署日期', asset.deployedAt || '—'],
    ];
    const grid = document.createElement('dl');
    grid.className = 'gdh-debot-rwa-popover__grid';
    rows.forEach(([label, value, tone]) => {
      const item = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      if (tone) dd.dataset.tone = tone;
      item.append(dt, dd);
      grid.append(item);
    });
    popover.append(grid);

    const address = document.createElement('div');
    address.className = 'gdh-debot-rwa-popover__address';
    address.textContent = asset.address;
    address.title = asset.address;
    popover.append(address);

    document.body.append(popover);
    debotRwaPopover = popover;
    debotRwaPopoverAnchor = anchor;
    positionDebotRwaPopover();
  }

  function openDebotRwaPoolLink(event) {
    if (event.type === 'keydown' && event.key === 'Escape') {
      closeDebotRwaPopover();
      return;
    }
    const target = event.target instanceof Element
      ? event.target.closest('.gdh-debot-rwa-link') : null;
    if (!target) {
      if (event.type === 'click' && debotRwaPopover
        && !(event.target instanceof Node && debotRwaPopover.contains(event.target))) {
        closeDebotRwaPopover();
      }
      return;
    }
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    const asset = debotRwaCatalog.get(String(target.dataset.gdhDebotRwaAddress || '').toLowerCase());
    if (!asset) return;
    event.preventDefault();
    event.stopPropagation();
    showDebotRwaPopover(target, asset);
  }

  function pumpTokenKey(value) {
    const text = safeText(value, 96);
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) return text.toLowerCase();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return text;
    const symbol = text.replace(/^\$+/, '').toUpperCase();
    return /^[A-Z0-9._-]{1,20}$/.test(symbol) ? symbol : '';
  }

  function loadMonitorFomo(raw) {
    monitorFomo = {
      muted: new Set((Array.isArray(raw?.muted) ? raw.muted : [])
        .map((value) => safeText(value, 80).toLowerCase()).filter(Boolean)),
      prefs: raw?.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {},
    };
  }

  function loadMonitorPump(raw) {
    const tokenValues = Array.isArray(raw?.tokenFilters) ? raw.tokenFilters : PUMP_DEFAULT_TOKEN_FILTERS;
    const globalMin = Number(raw?.globalTradeMinUsd);
    monitorPump = {
      muted: new Set((Array.isArray(raw?.muted) ? raw.muted : []).map(String).filter(Boolean)),
      prefs: raw?.prefs && typeof raw.prefs === 'object' && !Array.isArray(raw.prefs) ? raw.prefs : {},
      watch: new Set((Array.isArray(raw?.watch) ? raw.watch : []).map(String).filter(Boolean)),
      filters: raw?.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters) ? raw.filters : {},
      tokenFilters: new Set(tokenValues.map(pumpTokenKey).filter(Boolean)),
      onlyMine: raw?.onlyMine !== false,
      globalTradeMinUsd: Number.isFinite(globalMin) && globalMin >= 0 ? globalMin : 10,
    };
  }

  function blockedTokenSet() {
    return new Set((Array.isArray(settings.blockedTokens) ? settings.blockedTokens : []).flatMap((item) => {
      if (typeof item === 'string') return [normalizeAddress(item)];
      return [normalizeAddress(item?.address || item?.token || '')];
    }).filter(Boolean));
  }

  function fomoAllowed(event, blocked) {
    if (settings.fomoFeedTypes?.[event.type] === false) return false;
    if (monitorFomo.muted.has(safeText(event.handle, 80).toLowerCase())) return false;
    if (monitorFomo.prefs?.[event.handle]?.types?.[event.type] === false) return false;
    return !blocked.has(normalizeAddress(event.addr));
  }

  function pumpAllowed(event, blocked) {
    const wallet = safeText(event.pumpWallet, 96);
    if (!wallet || monitorPump.muted.has(wallet)) return false;
    if (monitorPump.prefs?.[wallet]?.types?.[event.type] === false) return false;
    if (blocked.has(normalizeAddress(event.addr))) return false;
    if (monitorPump.tokenFilters.has(pumpTokenKey(event.symbol))
      || monitorPump.tokenFilters.has(pumpTokenKey(event.addr))) return false;
    const personal = Number(monitorPump.filters?.[wallet]?.minTradeUsd ?? monitorPump.filters?.[wallet]);
    const minimum = Math.max(monitorPump.globalTradeMinUsd,
      Number.isFinite(personal) && personal > 0 ? personal : 0);
    if (minimum > 0 && Number(event.usd) > 0 && Number(event.usd) < minimum) return false;
    return !monitorPump.onlyMine || monitorPump.watch.has(wallet) || pumpDefaultWallets.has(wallet);
  }

  function eventIdentity(event) {
    const tx = safeText(event?.tx, 180);
    if (tx) return `tx:${tx.startsWith('0x') ? tx.toLowerCase() : tx}`;
    return `event:${event?.source || 'fomo'}:${normalizeAddress(event?.addr)}:${event?.type || ''}`
      + `:${normalizeAddress(event?.pumpWallet || event?.handle)}:${Math.round(Number(event?.ts) / 1000)}`
      + `:${Math.round(Number(event?.usd) * 100)}`;
  }

  function nativeRows(table) {
    return [...table.querySelectorAll('tbody tr[data-gdh-debot-track-ts]')]
      .filter((row) => row instanceof HTMLElement && !row.hasAttribute('data-gdh-debot-fomo-key'));
  }

  function nativeFingerprint(row) {
    return {
      tx: safeText(row.dataset.gdhDebotTrackTx, 180),
      addr: normalizeAddress(row.dataset.gdhDebotTrackToken),
      chain: safeText(row.dataset.gdhDebotTrackChain, 24).toLowerCase(),
      side: safeText(row.dataset.gdhDebotTrackSide, 16).toLowerCase(),
      maker: normalizeAddress(row.dataset.gdhDebotTrackWallet),
      ts: Number(row.dataset.gdhDebotTrackTs) || 0,
      usd: Number(row.dataset.gdhDebotTrackUsd) || 0,
    };
  }

  function isNativeDuplicate(event, row) {
    const side = safeText(event?.type, 16).toLowerCase();
    if (side !== 'buy' && side !== 'sell') return false;
    const tx = safeText(event?.tx, 180);
    if (tx && row.tx && normalizeAddress(tx) === normalizeAddress(row.tx)) return true;
    if (!event.addr || normalizeAddress(event.addr) !== row.addr || side !== row.side) return false;
    if (event.chain && row.chain && safeText(event.chain, 24).toLowerCase() !== row.chain) return false;
    if (!event.ts || !row.ts || Math.abs(Number(event.ts) - row.ts) > 15000) return false;
    if (event.source === 'pump' && normalizeAddress(event.pumpWallet) !== row.maker) return false;
    if (row.sidebar && event.source === 'pump') return true;
    const usd = Number(event.usd) || 0;
    return !!(usd && row.usd && Math.abs(usd - row.usd) <= Math.max(1, Math.max(usd, row.usd) * 0.05));
  }

  function visibleFeedEvents(rows = []) {
    const blocked = blockedTokenSet();
    const chain = settings.fomoFeedChainOnly === true ? currentTrackChain() : '';
    const out = [];
    if (settings.enabled !== false && settings.enableFomoFeed !== false) {
      for (const event of fomoEvents) {
        if (!event?.key || !Number(event.ts) || !fomoAllowed(event, blocked)) continue;
        if (chain && event.chain && event.chain !== chain) continue;
        out.push(event);
      }
    }
    if (settings.enabled !== false && settings.enablePumpFeed !== false) {
      for (const event of pumpEvents) {
        if (!event?.key || !Number(event.ts) || !pumpAllowed(event, blocked)) continue;
        if (chain && event.chain && event.chain !== chain) continue;
        out.push(event);
      }
    }
    const seen = new Set();
    return out.sort((a, b) => Number(b.ts) - Number(a.ts)).filter((event) => {
      const identity = eventIdentity(event);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return !rows.some((row) => isNativeDuplicate(event, row));
    }).slice(0, FEED_RENDER_CAP);
  }

  function profileMeta(event) {
    if (event.source === 'pump') {
      return { source: 'Pump', url: safeText(event.profileUrl, 500), name: event.name || event.pumpWallet || 'Pump' };
    }
    const handle = safeText(event.handle, 80);
    return {
      source: 'fomo',
      url: handle ? `https://fomo.family/profile/${encodeURIComponent(handle)}` : '',
      name: event.name || handle || 'fomo',
    };
  }

  function feedCell(className, text) {
    const cell = document.createElement('span');
    cell.className = `gdh-debot-feed__cell ${className}`;
    cell.textContent = text;
    return cell;
  }

  function buildFeedCard(event) {
    const tag = FEED_TAGS[event.type] || { label: '事件', cls: '' };
    const profile = profileMeta(event);
    const card = document.createElement('a');
    card.className = `gdh-debot-feed__row ${tag.cls}${event.source === 'pump' ? ' is-pump' : ''}`;
    card.dataset.gdhDebotFomoKey = safeText(event.key, 220);
    card.href = debotTokenHref(event.chain, event.addr);
    bindDebotNavigation(card);

    const stripe = document.createElement('span');
    stripe.className = 'gdh-debot-feed__stripe';
    stripe.style.backgroundColor = CHAIN_COLORS[event.chain] || '#8a93a6';
    card.appendChild(stripe);

    const who = feedCell('gdh-debot-feed__who', '');
    const avatar = document.createElement('span');
    avatar.className = 'gdh-debot-feed__avatar';
    const avatarUrl = validImageUrl(event.avatar);
    if (avatarUrl) {
      const image = document.createElement('img');
      image.src = avatarUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      avatar.appendChild(image);
    } else {
      avatar.textContent = safeText(profile.name, 1).toUpperCase() || '?';
    }
    const name = document.createElement('span');
    name.className = 'gdh-debot-feed__name';
    name.textContent = safeText(profile.name, 40);
    const source = document.createElement('span');
    source.className = 'gdh-debot-feed__source';
    source.textContent = profile.source;
    const openProfile = (click) => {
      click.preventDefault(); click.stopPropagation();
      if (/^https?:\/\//.test(profile.url)) window.open(profile.url, '_blank', 'noopener,noreferrer');
    };
    avatar.addEventListener('click', openProfile);
    name.addEventListener('click', openProfile);
    who.append(avatar, name, source);

    const token = feedCell('gdh-debot-feed__token', '');
    const logoUrl = validImageUrl(event.img);
    if (logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'gdh-debot-feed__logo';
      logo.src = logoUrl;
      logo.alt = '';
      logo.loading = 'lazy';
      logo.referrerPolicy = 'no-referrer';
      logo.addEventListener('error', () => logo.remove(), { once: true });
      token.appendChild(logo);
    }
    const symbol = document.createElement('strong');
    symbol.textContent = safeText(event.symbol, 24) || safeText(event.addr, 8);
    if (event.comment) symbol.title = safeText(event.comment, 500);
    token.appendChild(symbol);

    const action = feedCell(`gdh-debot-feed__action ${tag.cls}`, tag.label);
    const amount = feedCell('gdh-debot-feed__amount', Number(event.usd) > 0 ? fomoUsd(event.usd) : '—');
    const mc = feedCell('gdh-debot-feed__mc', Number(event.mc) > 0 ? fomoUsd(event.mc) : '—');
    const time = feedCell('gdh-debot-feed__time', relativeTime(event.ts));
    time.dataset.gdhTs = String(event.ts);
    card.append(who, token, action, amount, mc, time);
    const commentText = (event.type === 'thesis' || event.type === 'refund')
      ? safeMultilineText(event.comment) : '';
    if (commentText) {
      const comment = document.createElement('div');
      comment.className = 'gdh-debot-feed__comment';
      comment.textContent = commentText;
      card.classList.add('has-comment');
      card.appendChild(comment);
    }

    if (!feedSeen.has(event.key)) {
      feedSeen.add(event.key);
      card.classList.add('is-new');
      while (feedSeen.size > 600) feedSeen.delete(feedSeen.values().next().value);
    }
    return card;
  }

  function feedCard(event) {
    let card = feedCards.get(event.key);
    if (!card) {
      card = buildFeedCard(event);
      feedCards.set(event.key, card);
      while (feedCards.size > 120) {
        const first = feedCards.keys().next().value;
        feedCards.get(first)?.remove();
        feedCards.delete(first);
      }
    }
    const time = card.querySelector('.gdh-debot-feed__time');
    if (time) time.textContent = relativeTime(event.ts);
    return card;
  }

  function trackTable() {
    const marked = document.querySelector('tr[data-gdh-debot-track-ts]');
    if (marked) return marked.closest('table');
    for (const table of document.querySelectorAll('[data-virtuoso-scroller] table, table')) {
      const head = safeText(table.querySelector('thead')?.textContent, 500).toLowerCase();
      if ((head.includes('钱包') || head.includes('wallet'))
        && (head.includes('币种') || head.includes('token'))
        && (head.includes('市值') || head.includes('mkt'))) return table;
    }
    return null;
  }

  function trackScroller(table) {
    return table?.closest('[data-virtuoso-scroller="true"], [data-virtuoso-scroller]') || table?.parentElement || null;
  }

  function clearFeedLayout(table = trackTable()) {
    document.querySelectorAll('.gdh-debot-feed__row.is-absolute').forEach((card) => card.remove());
    document.querySelector('.gdh-debot-feed__fallback')?.remove();
    document.querySelectorAll('tr[data-gdh-debot-shift="1"]').forEach((row) => {
      row.style.translate = '';
      row.removeAttribute('data-gdh-debot-shift');
    });
    if (table?.dataset.gdhDebotMarginBottom !== undefined) {
      table.style.marginBottom = table.dataset.gdhDebotMarginBottom;
      delete table.dataset.gdhDebotMarginBottom;
    }
  }

  function renderFallback(table, events) {
    if (!events.length) return;
    const fallback = document.createElement('section');
    fallback.className = 'gdh-debot-feed__fallback';
    const title = document.createElement('div');
    title.className = 'gdh-debot-feed__fallback-title';
    title.textContent = 'FOMO / Pump';
    fallback.appendChild(title);
    for (const event of events.slice(0, 8)) {
      const card = feedCard(event);
      card.classList.remove('is-absolute');
      card.style.cssText = '';
      fallback.appendChild(card);
    }
    table.before(fallback);
  }

  function gridColumns(table) {
    const headers = [...table.querySelectorAll('thead th')];
    if (headers.length < 6) return 'minmax(170px,1.45fr) minmax(150px,1.25fr) 90px 120px 120px 80px';
    return headers.slice(0, 6).map((cell) => `${Math.max(60, Math.round(cell.getBoundingClientRect().width))}px`).join(' ');
  }

  function debotFeedPlacementPlan(rowTimes, events) {
    if (!rowTimes.length) return [];
    const plan = [];
    let headCount = 0;
    for (const event of events) {
      let anchor = -1;
      if (Number(event.ts) >= Number(rowTimes[0])) {
        if (headCount >= FEED_HEAD_CAP) continue;
        anchor = 0;
        headCount += 1;
      } else {
        anchor = rowTimes.findIndex((time) => Number(event.ts) >= Number(time));
        if (anchor < 0) continue;
      }
      plan.push({ event, anchor });
      if (plan.length >= FEED_VISIBLE_CAP) break;
    }
    return plan;
  }

  function sidebarFeedPlacementPlan(rowTimes, events) {
    if (!rowTimes.length) return [];
    const plan = [];
    let headCount = 0;
    for (const event of events) {
      let anchor = -1;
      if (Number(event.ts) >= Number(rowTimes[0])) {
        if (headCount >= SIDEBAR_FEED_HEAD_CAP) continue;
        anchor = 0;
        headCount += 1;
      } else {
        anchor = rowTimes.findIndex((time) => Number(event.ts) >= Number(time));
        if (anchor < 0) continue;
      }
      plan.push({ event, anchor });
      if (plan.length >= SIDEBAR_FEED_VISIBLE_CAP) break;
    }
    return plan;
  }

  function sidebarTrackLayout() {
    const panelRoot = document.querySelector('[data-edge-dock-panel="track"]');
    const scroller = panelRoot?.querySelector('[data-testid="virtuoso-scroller"]');
    const list = scroller?.querySelector('[data-testid="virtuoso-item-list"]');
    return scroller instanceof HTMLElement && list instanceof HTMLElement ? { scroller, list } : null;
  }

  function sidebarTrackRows(list) {
    return [...list.querySelectorAll(':scope > div[data-index][data-known-size], :scope > tr[data-index][data-known-size]')]
      .filter((row) => row instanceof HTMLElement && !row.hasAttribute('data-gdh-debot-fomo-key'));
  }

  function debotAbsoluteTimestamp(value, now = Date.now()) {
    const match = safeText(value, 24).match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return 0;
    const parts = match.slice(1).map(Number);
    if (parts[0] < 1 || parts[0] > 12 || parts[1] < 1 || parts[1] > 31
      || parts[2] > 23 || parts[3] > 59 || parts[4] > 59) return 0;
    const current = new Date(now);
    let timestamp = new Date(
      current.getFullYear(),
      parts[0] - 1,
      parts[1],
      parts[2],
      parts[3],
      parts[4],
    ).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    // 跨年时，DeBot 只显示月日；未来超过一天的记录属于上一年。
    if (timestamp > now + 86400000) {
      timestamp = new Date(
        current.getFullYear() - 1,
        parts[0] - 1,
        parts[1],
        parts[2],
        parts[3],
        parts[4],
      ).getTime();
    }
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function sidebarRowTime(row, now = Date.now()) {
    const absoluteLabel = [...row.querySelectorAll('[aria-label]')]
      .map((node) => safeText(node.getAttribute('aria-label'), 24))
      .find((value) => /^\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value));
    const absoluteTimestamp = debotAbsoluteTimestamp(absoluteLabel, now);
    if (absoluteTimestamp) return absoluteTimestamp;
    const rowRect = row.getBoundingClientRect();
    const candidates = [...row.querySelectorAll('span, div')].filter((node) => {
      if (node.children.length) return false;
      const text = safeText(node.textContent, 12);
      if (!/^\d+(?:s|m|h|d)$/.test(text)) return false;
      const rect = node.getBoundingClientRect();
      if (row.tagName === 'TR') return rect.left < rowRect.left + 64;
      return rect.right >= rowRect.right - 64 && rect.top < rowRect.top + 34;
    });
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return row.tagName === 'TR' ? ar.left - br.left : ar.top - br.top || br.right - ar.right;
    });
    const text = safeText(candidates[0]?.textContent, 12);
    const match = text.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return 0;
    const multiplier = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
    return now - Number(match[1]) * multiplier;
  }

  function sidebarNativeFingerprint(row, now = Date.now()) {
    const tokenLink = row.querySelector('a[href*="/token/"]');
    const walletLink = row.querySelector('a[href*="/address/"]');
    let tokenPath = '';
    let walletPath = '';
    try { tokenPath = new URL(tokenLink?.href || '', location.origin).pathname; } catch {}
    try { walletPath = new URL(walletLink?.href || '', location.origin).pathname; } catch {}
    const tokenMatch = tokenPath.match(/^\/token\/([a-z0-9_-]+)\/([^/?#]+)/i);
    const walletMatch = walletPath.match(/^\/address\/[a-z0-9_-]+\/([^/?#]+)/i);
    let addr = tokenMatch?.[2] || '';
    try { addr = decodeURIComponent(addr); } catch {}
    addr = addr.slice(addr.lastIndexOf('_') + 1);
    const text = safeText(row.innerText, 500);
    const side = /买入|建仓|加仓|转入/.test(text) ? 'buy'
      : /卖出|清仓|减仓/.test(text) ? 'sell' : '';
    return {
      tx: '',
      addr: normalizeAddress(addr),
      chain: safeText(tokenMatch?.[1], 24).toLowerCase(),
      side,
      maker: normalizeAddress(walletMatch?.[1]),
      ts: sidebarRowTime(row, now),
      usd: 0,
      sidebar: true,
    };
  }

  function sidebarFeedCard(event, layoutMeta) {
    layoutMeta = layoutMeta || {};
    const mode = layoutMeta.mode === 'list' ? 'list' : 'card';
    let card = sidebarFeedCards.get(event.key);
    if (card && card.dataset.gdhDebotMode !== mode) {
      card.remove();
      sidebarFeedCards.delete(event.key);
      card = null;
    }
    if (!card) {
      const tag = FEED_TAGS[event.type] || { label: '事件', cls: '' };
      const profile = profileMeta(event);
      card = document.createElement('a');
      card.className = `gdh-debot-sidefeed__row is-${mode} ${tag.cls}${event.source === 'pump' ? ' is-pump' : ''}`;
      card.dataset.gdhDebotFomoKey = safeText(event.key, 220);
      card.dataset.gdhDebotMode = mode;
      card.href = debotTokenHref(event.chain, event.addr);
      bindDebotNavigation(card);

      const stripe = document.createElement('span');
      stripe.className = 'gdh-debot-sidefeed__stripe';
      stripe.style.backgroundColor = CHAIN_COLORS[event.chain] || '#8a93a6';
      const avatar = document.createElement('span');
      avatar.className = 'gdh-debot-sidefeed__avatar';
      const avatarUrl = validImageUrl(event.avatar);
      if (avatarUrl) {
        const image = document.createElement('img');
        image.src = avatarUrl;
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        avatar.appendChild(image);
      } else {
        avatar.textContent = safeText(profile.name, 1).toUpperCase() || '?';
      }
      const name = document.createElement('strong');
      name.className = 'gdh-debot-sidefeed__name';
      name.textContent = safeText(profile.name, 28);
      const action = document.createElement('span');
      action.className = `gdh-debot-sidefeed__action ${tag.cls}`;
      action.textContent = tag.label;
      const source = document.createElement('span');
      source.className = 'gdh-debot-sidefeed__source';
      source.textContent = profile.source;
      const time = document.createElement('span');
      time.className = 'gdh-debot-sidefeed__time';
      time.dataset.gdhTs = String(event.ts);
      time.textContent = relativeTime(event.ts);

      const amount = document.createElement('strong');
      amount.className = 'gdh-debot-sidefeed__amount';
      amount.textContent = Number(event.usd) > 0 ? fomoUsd(event.usd) : '—';
      const symbol = document.createElement('span');
      symbol.className = 'gdh-debot-sidefeed__symbol';
      symbol.textContent = safeText(event.symbol, 24) || safeText(event.addr, 8);
      const block = document.createElement('button');
      block.type = 'button';
      block.className = 'gdh-debot-sidefeed__block';
      block.textContent = '🚫';
      block.title = '长按 1 秒屏蔽这个代币';
      let blockTimer = 0;
      const cancelBlock = () => {
        if (blockTimer) window.clearTimeout(blockTimer);
        blockTimer = 0;
        block.classList.remove('is-holding');
      };
      block.addEventListener('pointerdown', (pointerEvent) => {
        pointerEvent.preventDefault(); pointerEvent.stopPropagation();
        cancelBlock();
        block.classList.add('is-holding');
        blockTimer = window.setTimeout(() => {
          blockTimer = 0;
          block.classList.remove('is-holding');
          blockToken(event.addr, event.symbol);
        }, 1000);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => block.addEventListener(type, cancelBlock));
      block.addEventListener('click', (clickEvent) => { clickEvent.preventDefault(); clickEvent.stopPropagation(); });
      symbol.appendChild(block);
      const mc = document.createElement('span');
      mc.className = 'gdh-debot-sidefeed__mc';
      mc.textContent = Number(event.mc) > 0 ? `MC ${fomoUsd(event.mc)}` : '';
      const commentText = (event.type === 'thesis' || event.type === 'refund')
        ? safeMultilineText(event.comment) : '';
      const comment = commentText ? document.createElement('div') : null;
      if (comment) {
        comment.className = 'gdh-debot-sidefeed__comment';
        comment.textContent = commentText;
        card.classList.add('has-comment');
      }
      if (mode === 'list') {
        const cells = [time, action, null, symbol, amount, mc].map((content, index) => {
          const cell = document.createElement('span');
          cell.className = `gdh-debot-sidefeed__list-cell is-col-${index + 1}`;
          if (index === 2) cell.append(avatar, name, source);
          else if (content) cell.appendChild(content);
          return cell;
        });
        const sampleCells = [...(layoutMeta.sampleRow?.children || [])];
        if (sampleCells.length >= 6) {
          const columns = sampleCells.slice(0, 6)
            .map((cell) => `${Math.max(36, Math.round(cell.getBoundingClientRect().width))}px`).join(' ');
          card.style.gridTemplateColumns = columns;
        }
        card.append(stripe, ...cells);
      } else {
        card.append(stripe, avatar, name, action, source, time, amount, symbol, mc);
      }
      if (comment) card.appendChild(comment);

      sidebarFeedCards.set(event.key, card);
      while (sidebarFeedCards.size > 80) {
        const first = sidebarFeedCards.keys().next().value;
        sidebarFeedCards.get(first)?.remove();
        sidebarFeedCards.delete(first);
      }
    }
    const time = card.querySelector('.gdh-debot-sidefeed__time');
    if (time) time.textContent = relativeTime(event.ts);
    return card;
  }

  function measuredFeedCardHeight(card, fallback) {
    const minimum = Math.max(1, Number(fallback) || 1);
    if (!card?.classList?.contains('has-comment')) return minimum;
    return Math.max(minimum, Math.ceil(card.getBoundingClientRect().height), Math.ceil(card.scrollHeight));
  }

  /**
   * DeBot 使用固定 46px 的 TableVirtuoso 行。插件卡片放在同一滚动坐标系，
   * 原生行只用独立 CSS translate 让位；不向 React 的 tbody 塞未知节点。
   */
  function layoutFeed() {
    const table = trackTable();
    clearFeedLayout(table);
    if (!isTrackPage() || !table || settings.enabled === false
      || (settings.enableFomoFeed === false && settings.enablePumpFeed === false)) return;

    const rows = nativeRows(table);
    const fingerprints = rows.map(nativeFingerprint);
    const events = visibleFeedEvents(fingerprints);
    if (!rows.length) {
      renderFallback(table, events);
      return;
    }

    const scroller = trackScroller(table);
    if (!(scroller instanceof HTMLElement)) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const rowInfo = rows.map((row) => ({
      row,
      ts: Number(row.dataset.gdhDebotTrackTs) || 0,
      top: row.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop,
    })).filter((item) => item.ts > 0).sort((a, b) => a.top - b.top);
    if (!rowInfo.length) return void renderFallback(table, events);

    const groups = new Map();
    for (const { event, anchor } of debotFeedPlacementPlan(rowInfo.map((item) => item.ts), events)) {
      const bucket = groups.get(anchor) || [];
      bucket.push(event);
      groups.set(anchor, bucket);
    }
    if (!groups.size) return;

    if (getComputedStyle(scroller).position === 'static') scroller.style.position = 'relative';
    table.dataset.gdhDebotMarginBottom = table.style.marginBottom || '';
    const left = tableRect.left - scrollerRect.left + scroller.scrollLeft;
    const width = tableRect.width;
    const columns = gridColumns(table);
    let insertedHeight = 0;
    for (let index = 0; index < rowInfo.length; index += 1) {
      const bucket = groups.get(index) || [];
      let bucketHeight = 0;
      bucket.forEach((event) => {
        const card = feedCard(event);
        card.classList.add('is-absolute');
        card.style.top = `${rowInfo[index].top + insertedHeight + bucketHeight}px`;
        card.style.left = `${left}px`;
        card.style.width = `${width}px`;
        card.style.gridTemplateColumns = columns;
        scroller.appendChild(card);
        bucketHeight += measuredFeedCardHeight(card, FEED_ROW_HEIGHT);
      });
      insertedHeight += bucketHeight;
      if (insertedHeight) {
        rowInfo[index].row.style.translate = `0 ${insertedHeight}px`;
        rowInfo[index].row.dataset.gdhDebotShift = '1';
      }
    }
    table.style.marginBottom = `${insertedHeight}px`;
  }

  function clearSidebarFeedLayout(layout = sidebarTrackLayout()) {
    document.querySelectorAll('.gdh-debot-sidefeed__row').forEach((card) => card.remove());
    document.querySelectorAll('[data-gdh-debot-sidebar-shift="1"]').forEach((row) => {
      row.style.translate = row.dataset.gdhDebotSidebarTranslate || '';
      delete row.dataset.gdhDebotSidebarTranslate;
      row.removeAttribute('data-gdh-debot-sidebar-shift');
    });
    if (layout?.list?.dataset.gdhDebotSidebarMarginBottom !== undefined) {
      layout.list.style.marginBottom = layout.list.dataset.gdhDebotSidebarMarginBottom;
      delete layout.list.dataset.gdhDebotSidebarMarginBottom;
    }
  }

  function layoutSidebarFeed() {
    const layout = sidebarTrackLayout();
    clearSidebarFeedLayout(layout);
    if (!isTrackShellPage() || !layout || settings.enabled === false
      || (settings.enableFomoFeed === false && settings.enablePumpFeed === false)) return;

    const rows = sidebarTrackRows(layout.list);
    if (!rows.length) return;
    const mode = rows[0].tagName === 'TR' ? 'list' : 'card';
    const measured = Number(rows[0].dataset.knownSize) || rows[0].getBoundingClientRect().height;
    const rowHeight = Number.isFinite(measured) && measured >= 32 && measured <= 120
      ? Math.round(measured) : (mode === 'list' ? 40 : 67);
    const now = Date.now();
    const rowInfo = rows.map((row) => ({
      row,
      fingerprint: sidebarNativeFingerprint(row, now),
    })).filter((item) => item.fingerprint.ts > 0);
    if (!rowInfo.length) return;
    const events = visibleFeedEvents(rowInfo.map((item) => item.fingerprint));
    const plan = sidebarFeedPlacementPlan(rowInfo.map((item) => item.fingerprint.ts), events);
    if (!plan.length) return;

    const scrollerRect = layout.scroller.getBoundingClientRect();
    const listRect = layout.list.getBoundingClientRect();
    const groups = new Map();
    for (const { event, anchor } of plan) {
      const bucket = groups.get(anchor) || [];
      bucket.push(event);
      groups.set(anchor, bucket);
    }
    let insertedHeight = 0;
    for (let index = 0; index < rowInfo.length; index += 1) {
      const bucket = groups.get(index) || [];
      const baseTop = rowInfo[index].row.getBoundingClientRect().top
        - scrollerRect.top + layout.scroller.scrollTop;
      let bucketHeight = 0;
      bucket.forEach((event) => {
        const card = sidebarFeedCard(event, { mode, rowHeight, sampleRow: rows[0] });
        card.style.setProperty('--gdh-debot-row-height', `${rowHeight}px`);
        card.style.top = `${baseTop + insertedHeight + bucketHeight}px`;
        card.style.left = `${listRect.left - scrollerRect.left + layout.scroller.scrollLeft}px`;
        card.style.width = `${listRect.width}px`;
        layout.scroller.appendChild(card);
        bucketHeight += measuredFeedCardHeight(card, rowHeight);
      });
      insertedHeight += bucketHeight;
      if (insertedHeight) {
        const row = rowInfo[index].row;
        row.dataset.gdhDebotSidebarTranslate = row.style.translate || '';
        row.dataset.gdhDebotSidebarShift = '1';
        row.style.translate = `0 ${insertedHeight}px`;
      }
    }
    layout.list.dataset.gdhDebotSidebarMarginBottom = layout.list.style.marginBottom || '';
    layout.list.style.marginBottom = `${insertedHeight}px`;
  }

  function normalizeWalletAddress(value) {
    const text = safeText(value, 96);
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) return text.toLowerCase();
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) ? text : '';
  }

  function normalizeSpecialColor(value) {
    if (value === 'rainbow') return 'rainbow';
    return /^#[0-9a-fA-F]{6}$/.test(String(value || ''))
      ? String(value).toLowerCase() : SPECIAL_COLOR_PALETTE[0];
  }

  function rebuildSpecialWalletMap() {
    specialWalletMap = new Map((Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => {
        const address = normalizeWalletAddress(item?.address);
        return address ? [address, {
          label: safeText(item?.label, 32),
          color: normalizeSpecialColor(item?.color),
          pin: item?.pin === true,
        }] : null;
      }).filter(Boolean));
  }

  function persistSpecialWallets(next) {
    settings.specialWallets = next;
    rebuildSpecialWalletMap();
    chrome.storage.local.set({ specialWallets: next });
    scheduleFeedLayout();
  }

  function toggleSpecialWallet(address, label = '') {
    const normalized = normalizeWalletAddress(address);
    if (!normalized) return false;
    const list = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    const exists = list.some((item) => normalizeWalletAddress(item?.address) === normalized);
    persistSpecialWallets(exists
      ? list.filter((item) => normalizeWalletAddress(item?.address) !== normalized)
      : [...list, { address: normalized, label: safeText(label, 32), color: SPECIAL_COLOR_PALETTE[0], pin: false }]);
    return true;
  }

  function updateSpecialWallet(address, patch) {
    const normalized = normalizeWalletAddress(address);
    if (!normalized || !specialWalletMap.has(normalized)) return;
    const list = (Array.isArray(settings.specialWallets) ? settings.specialWallets : []).map((item) => (
      normalizeWalletAddress(item?.address) === normalized ? { ...item, ...patch } : item
    ));
    persistSpecialWallets(list);
  }

  function specialRgba(color, alpha) {
    const match = String(color).match(/^#([0-9a-fA-F]{6})$/);
    if (!match) return `rgba(245, 184, 61, ${alpha})`;
    const value = parseInt(match[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function sidebarWalletMeta(row) {
    const links = [...row.querySelectorAll('a[href*="/address/"]')];
    const link = links.find((item) => safeText(item.textContent, 40)) || links[0];
    let address = '';
    try {
      const pathname = new URL(link?.getAttribute('href') || '', location.origin).pathname;
      address = pathname.match(/^\/address\/[a-z0-9_-]+\/([^/?#]+)/i)?.[1] || '';
      address = decodeURIComponent(address);
    } catch {}
    address = normalizeWalletAddress(address || row.dataset.gdhDebotTrackWallet);
    return { address, label: safeText(link?.textContent, 32), link };
  }

  function closeSpecialPalette() {
    specialPalette?.remove();
    specialPalette = null;
  }

  function openSpecialPalette(address, anchorRect) {
    closeSpecialPalette();
    const meta = specialWalletMap.get(address);
    if (!meta) return;
    const palette = document.createElement('div');
    palette.className = 'gdh-debot-special-palette';
    palette.addEventListener('pointerdown', (event) => event.stopPropagation());
    for (const color of [...SPECIAL_COLOR_PALETTE, 'rainbow']) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `gdh-debot-special-palette__dot${color === 'rainbow' ? ' is-rainbow' : ''}`;
      if (color !== 'rainbow') dot.style.background = color;
      dot.classList.toggle('is-active', meta.color === color);
      dot.title = color === 'rainbow' ? '炫彩' : color;
      dot.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        updateSpecialWallet(address, { color });
        closeSpecialPalette();
      });
      palette.appendChild(dot);
    }
    const pin = document.createElement('label');
    pin.className = 'gdh-debot-special-palette__pin';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = meta.pin;
    input.addEventListener('change', () => updateSpecialWallet(address, { pin: input.checked }));
    pin.append(input, document.createTextNode('📌 新推送置顶 10 秒'));
    palette.appendChild(pin);
    document.body.appendChild(palette);
    const width = palette.offsetWidth || 230;
    const height = palette.offsetHeight || 70;
    palette.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - width / 2))}px`;
    palette.style.top = `${anchorRect.bottom + height + 8 <= window.innerHeight
      ? anchorRect.bottom + 6 : Math.max(8, anchorRect.top - height - 6)}px`;
    specialPalette = palette;
  }

  function applySpecialRow(row) {
    const { address, label, link } = sidebarWalletMeta(row);
    if (!address) return null;
    const meta = specialWalletMap.get(address);
    row.classList.toggle('gdh-debot-special-row', Boolean(meta));
    if (meta) {
      row.dataset.gdhDebotSpecial = '1';
      row.dataset.gdhDebotSpecialRainbow = meta.color === 'rainbow' ? '1' : '0';
      if (meta.color !== 'rainbow') {
        row.style.setProperty('--gdh-debot-special-bg', specialRgba(meta.color, 0.13));
        row.style.setProperty('--gdh-debot-special-color', meta.color);
      }
    } else {
      delete row.dataset.gdhDebotSpecial;
      delete row.dataset.gdhDebotSpecialRainbow;
      row.style.removeProperty('--gdh-debot-special-bg');
      row.style.removeProperty('--gdh-debot-special-color');
    }
    let star = row.querySelector(':scope .gdh-debot-special-star');
    if (!star && link?.parentElement) {
      star = document.createElement('button');
      star.type = 'button';
      star.className = 'gdh-debot-special-star';
      star.addEventListener('pointerdown', (event) => event.stopPropagation());
      star.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        toggleSpecialWallet(star.dataset.address, star.dataset.label);
      });
      link.insertAdjacentElement('afterend', star);
    }
    if (star) {
      star.dataset.address = address;
      star.dataset.label = label;
      star.textContent = meta ? '★' : '☆';
      star.classList.toggle('is-active', Boolean(meta));
      star.classList.toggle('is-rainbow', meta?.color === 'rainbow');
      star.style.color = meta && meta.color !== 'rainbow' ? meta.color : '';
      star.title = meta ? '取消重点关注' : '加入重点关注';
    }
    let swatch = row.querySelector(':scope .gdh-debot-special-swatch');
    if (meta && star) {
      if (!swatch) {
        swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'gdh-debot-special-swatch';
        swatch.addEventListener('pointerdown', (event) => event.stopPropagation());
        swatch.addEventListener('click', (event) => {
          event.preventDefault(); event.stopPropagation();
          openSpecialPalette(swatch.dataset.address, swatch.getBoundingClientRect());
        });
        star.insertAdjacentElement('afterend', swatch);
      }
      swatch.dataset.address = address;
      swatch.style.background = meta.color === 'rainbow'
        ? 'conic-gradient(#ef5350,#f5b83d,#43c07a,#4c9ffe,#b48ae0,#ed6ba4,#ef5350)'
        : meta.color;
    } else swatch?.remove();
    return { address, label, meta };
  }

  function rememberSpecialPin(signature) {
    specialPinSeen.add(signature);
    while (specialPinSeen.size > SPECIAL_PIN_SEEN_MAX) specialPinSeen.delete(specialPinSeen.values().next().value);
  }

  function sidebarRowSignature(row, address) {
    const token = row.querySelector('a[href*="/token/"]')?.getAttribute('href') || '';
    const ts = Number(row.dataset.gdhDebotTrackTs) || sidebarRowTime(row);
    const side = safeText(row.dataset.gdhDebotTrackSide, 12)
      || safeText((row.innerText.match(/建仓|加仓|减仓|清仓|买入|卖出|转入|转出/) || [])[0], 12);
    const tx = safeText(row.dataset.gdhDebotTrackTx, 180);
    return tx ? `${address}|tx:${tx}` : `${address}|${token}|${side}|${Math.round(ts / 1000)}`;
  }

  function cloneNativeSidebarRow(row) {
    const clone = row.cloneNode(true);
    clone.classList.remove('gdh-debot-special-row');
    clone.querySelectorAll('.gdh-debot-special-star, .gdh-debot-special-swatch').forEach((node) => node.remove());
    for (const element of [clone, ...clone.querySelectorAll('[data-gdh-debot-special], [data-gdh-debot-special-rainbow]')]) {
      delete element.dataset.gdhDebotSpecial;
      delete element.dataset.gdhDebotSpecialRainbow;
      element.style.removeProperty('--gdh-debot-special-bg');
      element.style.removeProperty('--gdh-debot-special-color');
    }
    clone.removeAttribute('data-index');
    clone.removeAttribute('data-item-index');
    clone.removeAttribute('data-known-size');
    clone.removeAttribute('data-gdh-debot-sidebar-shift');
    clone.removeAttribute('data-gdh-debot-sidebar-translate');
    clone.style.translate = '';
    clone.style.transform = '';
    clone.style.position = '';
    clone.style.inset = '';
    clone.classList.add('gdh-debot-special-pin-native');
    return clone;
  }

  function pinSidebarRow(row) {
    const root = document.querySelector('[data-edge-dock-panel="track"]');
    const scroller = root?.querySelector('[data-testid="virtuoso-scroller"]');
    const href = row.querySelector('a[href*="/token/"]')?.getAttribute('href') || '';
    if (!(root instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !href) return;
    if (!specialPinStrip?.isConnected) {
      specialPinStrip = document.createElement('div');
      specialPinStrip.className = 'gdh-debot-special-pin-strip';
      root.appendChild(specialPinStrip);
    }
    const rootRect = root.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    specialPinStrip.style.top = `${Math.max(42, Math.round(scrollerRect.top - rootRect.top))}px`;
    while (specialPinStrip.children.length >= SPECIAL_PIN_MAX) specialPinStrip.lastElementChild.remove();
    const item = document.createElement('div');
    item.className = 'gdh-debot-special-pin-item';
    item.style.setProperty('--gdh-debot-pin-height', `${Math.max(40, Math.ceil(row.getBoundingClientRect().height))}px`);
    const nativeRow = cloneNativeSidebarRow(row);
    const nativeTokenLink = nativeRow.matches('a[href*="/token/"]')
      ? nativeRow : nativeRow.querySelector('a[href*="/token/"]');
    if (nativeTokenLink instanceof HTMLAnchorElement) bindDebotNavigation(nativeTokenLink);
    if (nativeRow instanceof HTMLTableRowElement) {
      const table = document.createElement('table');
      table.className = 'gdh-debot-special-pin-table';
      const colgroup = row.closest('table')?.querySelector(':scope > colgroup')?.cloneNode(true);
      const body = document.createElement('tbody');
      body.appendChild(nativeRow);
      if (colgroup) table.appendChild(colgroup);
      table.appendChild(body);
      item.appendChild(table);
    } else item.appendChild(nativeRow);
    specialPinStrip.prepend(item);
    window.setTimeout(() => {
      item.remove();
      if (specialPinStrip && !specialPinStrip.children.length) {
        specialPinStrip.remove(); specialPinStrip = null;
      }
    }, SPECIAL_PIN_MS);
  }

  function unblockToken(address) {
    const normalized = normalizeAddress(address);
    const list = (Array.isArray(settings.blockedTokens) ? settings.blockedTokens : []).filter((item) => (
      normalizeAddress(typeof item === 'string' ? item : item?.address || item?.token) !== normalized
    ));
    settings.blockedTokens = list;
    chrome.storage.local.set({ blockedTokens: list });
    scheduleFeedLayout();
  }

  function blockToken(address, symbol = '') {
    const normalized = normalizeAddress(address);
    if (!normalized || blockedTokenSet().has(normalized)) return;
    const list = Array.isArray(settings.blockedTokens) ? settings.blockedTokens : [];
    settings.blockedTokens = [...list, { address: normalized, symbol: safeText(symbol, 24) }];
    chrome.storage.local.set({ blockedTokens: settings.blockedTokens });
    scheduleFeedLayout();
  }

  function ensureSpecialManageUI(root) {
    if (!(root instanceof HTMLElement)) return;
    let button = root.querySelector(':scope > .gdh-debot-special-manage-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-debot-special-manage-button';
      button.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        specialManageOpen = !specialManageOpen;
        scheduleFeedLayout();
      });
      root.appendChild(button);
    }
    button.textContent = `★${specialWalletMap.size}`;
    button.title = '重点关注管理';
    button.classList.toggle('is-active', specialManageOpen);
    let modal = root.querySelector(':scope > .gdh-debot-special-manage');
    if (!specialManageOpen) { modal?.remove(); return; }
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-debot-special-manage';
      root.appendChild(modal);
    }
    const blocked = [...blockedTokenSet()];
    const renderKey = JSON.stringify([settings.specialWallets, blocked]);
    if (modal.dataset.renderKey === renderKey) return;
    modal.dataset.renderKey = renderKey;
    modal.replaceChildren();
    const head = document.createElement('div'); head.className = 'gdh-debot-special-manage__head';
    const title = document.createElement('strong'); title.textContent = `重点关注 · ${specialWalletMap.size}`;
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×';
    close.addEventListener('click', () => { specialManageOpen = false; modal.remove(); button.classList.remove('is-active'); });
    head.append(title, close); modal.appendChild(head);
    const add = document.createElement('div'); add.className = 'gdh-debot-special-manage__add';
    const address = document.createElement('input'); address.placeholder = '钱包地址'; address.spellcheck = false;
    const label = document.createElement('input'); label.placeholder = '备注';
    const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = '添加';
    submit.addEventListener('click', () => {
      const normalized = normalizeWalletAddress(address.value);
      if (!normalized || specialWalletMap.has(normalized)) return void address.classList.add('is-error');
      toggleSpecialWallet(normalized, label.value); address.value = ''; label.value = '';
    });
    add.append(address, label, submit); modal.appendChild(add);
    const list = document.createElement('div'); list.className = 'gdh-debot-special-manage__list';
    for (const [walletAddress, meta] of specialWalletMap) {
      const row = document.createElement('div'); row.className = 'gdh-debot-special-manage__row';
      const swatch = document.createElement('button'); swatch.type = 'button'; swatch.className = 'gdh-debot-special-swatch';
      swatch.style.background = meta.color === 'rainbow'
        ? 'conic-gradient(#ef5350,#f5b83d,#43c07a,#4c9ffe,#b48ae0,#ed6ba4,#ef5350)' : meta.color;
      swatch.addEventListener('click', () => openSpecialPalette(walletAddress, swatch.getBoundingClientRect()));
      const pin = document.createElement('button'); pin.type = 'button'; pin.textContent = '📌'; pin.className = meta.pin ? 'is-pinned' : '';
      pin.title = meta.pin ? '取消新推送置顶' : '新推送置顶 10 秒';
      pin.addEventListener('click', () => updateSpecialWallet(walletAddress, { pin: !meta.pin }));
      const name = document.createElement('span'); name.textContent = meta.label || `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除';
      remove.addEventListener('click', () => toggleSpecialWallet(walletAddress));
      row.append(swatch, pin, name, remove); list.appendChild(row);
    }
    if (!specialWalletMap.size) list.textContent = '还没有重点关注的钱包';
    modal.appendChild(list);
    if (blocked.length) {
      const blockedBox = document.createElement('div'); blockedBox.className = 'gdh-debot-special-manage__blocked';
      const blockedTitle = document.createElement('strong'); blockedTitle.textContent = `已屏蔽代币 · ${blocked.length}`;
      blockedBox.appendChild(blockedTitle);
      for (const token of blocked) {
        const restore = document.createElement('button'); restore.type = 'button';
        restore.textContent = `${token.slice(0, 6)}…${token.slice(-4)}  恢复`;
        restore.addEventListener('click', () => unblockToken(token));
        blockedBox.appendChild(restore);
      }
      modal.appendChild(blockedBox);
    }
  }

  function scanSidebarFeatures() {
    const layout = sidebarTrackLayout();
    const root = document.querySelector('[data-edge-dock-panel="track"]');
    if (!isTrackShellPage() || !layout || !(root instanceof HTMLElement) || settings.enableSpecialWallet === false) {
      document.querySelectorAll('.gdh-debot-special-star, .gdh-debot-special-swatch, .gdh-debot-special-manage-button, .gdh-debot-special-manage')
        .forEach((node) => node.remove());
      document.querySelectorAll('[data-gdh-debot-special]').forEach((row) => {
        row.classList.remove('gdh-debot-special-row');
        delete row.dataset.gdhDebotSpecial;
        delete row.dataset.gdhDebotSpecialRainbow;
        row.style.removeProperty('--gdh-debot-special-bg');
        row.style.removeProperty('--gdh-debot-special-color');
      });
      specialPinStrip?.remove(); specialPinStrip = null;
      return;
    }
    ensureSpecialManageUI(root);
    const rows = sidebarTrackRows(layout.list);
    const current = [];
    for (const row of rows) {
      const wallet = applySpecialRow(row);
      if (!wallet) continue;
      const signature = sidebarRowSignature(row, wallet.address);
      current.push({ row, wallet, signature });
    }
    if (!specialPinBaselineDone) {
      current.forEach((item) => rememberSpecialPin(item.signature));
      specialPinBaselineDone = true;
      return;
    }
    for (const item of current) {
      if (specialPinSeen.has(item.signature)) continue;
      rememberSpecialPin(item.signature);
      if (item.wallet.meta?.pin) pinSidebarRow(item.row);
    }
  }

  function layoutFeeds() {
    feedRenderRaf = 0;
    layoutFeed();
    scanSidebarFeatures();
    layoutSidebarFeed();
  }

  function scheduleFeedLayout() {
    if (feedRenderRaf || document.visibilityState === 'hidden') return;
    feedRenderRaf = window.requestAnimationFrame(layoutFeeds);
  }

  async function pollFomo(force = false) {
    if (!isTrackShellPage() || settings.enabled === false || settings.enableFomoFeed === false) return;
    if (!force && Date.now() - feedLastFomoAt < FEED_POLL_MS) return;
    feedLastFomoAt = Date.now();
    const response = await runtimeMessage({ type: 'fomo-feed' });
    if (!response?.ok) return;
    fomoEvents = Array.isArray(response.events) ? response.events : [];
    scheduleFeedLayout();
  }

  async function pollPump(force = false) {
    if (!isTrackShellPage() || settings.enabled === false || settings.enablePumpFeed === false) return;
    if (!force && Date.now() - feedLastPumpAt < FEED_POLL_MS) return;
    feedLastPumpAt = Date.now();
    const response = await runtimeMessage({ type: 'pump-feed' });
    if (!response?.ok) return;
    pumpEvents = Array.isArray(response.events) ? response.events : [];
    pumpDefaultWallets = new Set((Array.isArray(response.defaultWallets) ? response.defaultWallets : []).map(String));
    scheduleFeedLayout();
  }

  function deepPick(object, keyPattern, kind, depth = 0, seen = new Set()) {
    if (!object || typeof object !== 'object' || depth > 3 || seen.has(object)) return undefined;
    seen.add(object);
    const accept = (value) => {
      if (kind === 'number') {
        const number = Number(value);
        return Number.isFinite(number) && value !== '' && value !== true && value !== false ? number : undefined;
      }
      if (kind === 'url') return validImageUrl(value) || undefined;
      const text = typeof value === 'string' ? safeText(value, 500) : '';
      return text && !/^https?:\/\//.test(text) ? text : undefined;
    };
    for (const [key, value] of Object.entries(object)) {
      if (!keyPattern.test(key)) continue;
      const accepted = accept(value);
      if (accepted !== undefined) return accepted;
    }
    for (const value of Object.values(object)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const hit = deepPick(value, keyPattern, kind, depth + 1, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  function fomoUser(item) {
    return item && typeof item.user === 'object' ? item.user : item || {};
  }

  function userName(item) {
    const user = fomoUser(item);
    return safeText(user.userHandle || user.displayName
      || deepPick(item, /(username|handle|displayname|nickname)/i, 'string') || '匿名', 60);
  }

  function userAvatar(item) {
    const user = fomoUser(item);
    return validImageUrl(user.profilePictureLink || item?.profilePictureLink)
      || deepPick(item, /(profilepic|profileimage|avatar|picture|image|photo)/i, 'url') || '';
  }

  function holderAmount(item) {
    const direct = Number(item?.humanAmount);
    if (direct > 0) return direct;
    const found = deepPick(item, /^(human_?amount|token_?amount|amount|balance|quantity|qty|size)$/i, 'number');
    if (Number(found) > 0) return Number(found);
    const usd = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
    const price = Number(item?.priceUsd ?? item?.price ?? deepPick(item, /^(price|price_?usd|token_?price)$/i, 'number'));
    return usd > 0 && price > 0 ? usd / price : 0;
  }

  function panelHeader(item) {
    const head = document.createElement('div');
    head.className = 'gdh-debot-fomo__item-head';
    const avatarUrl = userAvatar(item);
    if (avatarUrl) {
      const image = document.createElement('img');
      image.className = 'gdh-debot-fomo__avatar';
      image.src = avatarUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      head.appendChild(image);
    }
    const name = document.createElement('strong');
    name.textContent = userName(item);
    head.appendChild(name);
    return head;
  }

  function paintPnlTag(element, response) {
    const pnl = Number(response?.pnl);
    element.className = 'gdh-debot-fomo__pnl-tag';
    if (!response?.ok || !Number.isFinite(pnl)) {
      element.textContent = '—';
      return;
    }
    element.classList.add(pnl >= 0 ? 'is-up' : 'is-down');
    element.textContent = `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl) || '$0'}`;
    element.title = '7 天盈亏';
  }

  function pumpPnlQueue() {
    while (pnlActive < 3 && pnlQueue.length) {
      const job = pnlQueue.shift();
      if (!job.element.isConnected) continue;
      const cached = pnlCache.get(job.userId);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        paintPnlTag(job.element, cached.data);
        continue;
      }
      pnlActive += 1;
      runtimeMessage({ type: 'fomo-user-pnl', payload: { userId: job.userId } })
        .then((response) => {
          pnlCache.set(job.userId, { at: Date.now(), data: response });
          while (pnlCache.size > 300) pnlCache.delete(pnlCache.keys().next().value);
          if (job.element.isConnected) paintPnlTag(job.element, response);
        }).finally(() => { pnlActive -= 1; pumpPnlQueue(); });
    }
  }

  function watchPnl(element, userId, root) {
    if (!userId || !('IntersectionObserver' in window)) return;
    if (!pnlObserver) {
      pnlObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          pnlQueue.push({ element: entry.target, userId: entry.target.dataset.gdhUid });
        }
        pumpPnlQueue();
      }, { root, rootMargin: '100px' });
    }
    element.dataset.gdhUid = String(userId);
    pnlObserver.observe(element);
  }

  function translationForeignProbe(text) {
    return String(text || '')
      .replace(/https?:[/][/]\S+/gi, ' ')
      .replace(/\b0x[a-f\d]+\b/gi, ' ')
      .replace(/[一-鿿豈-﫿]+/g, ' ')
      .replace(/[^A-Za-zÀ-ɏ\u0370-\u052f\u0590-\u06ff\u0900-\u097f\u3040-\u30ff\uac00-\ud7af\s\u0027-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function translationFallbackLang(text) {
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    return /[A-Za-z]/.test(text) ? 'en' : '';
  }

  async function detectTranslationLanguage(text) {
    const probe = translationForeignProbe(text);
    if (!probe) return 'zh';
    const fallback = translationFallbackLang(probe);
    const api = globalThis.LanguageDetector;
    if (!api) return fallback;
    try {
      if (!translationDetector) translationDetector = await api.create();
      const list = await translationDetector.detect(probe);
      const detected = (Array.isArray(list) ? list : []).find((item) => {
        const lang = String(item?.detectedLanguage || '').split('-')[0];
        return lang && lang !== 'zh' && Number(item?.confidence) > 0;
      });
      return String(detected?.detectedLanguage || '').split('-')[0] || fallback;
    } catch {
      return fallback;
    }
  }

  function syncTranslationButton() {
    const button = panel?.querySelector('.gdh-debot-fomo__translate');
    if (!button) return;
    const supported = !!globalThis.Translator;
    button.classList.toggle('is-active', supported && settings.fomoTranslate && !translationNeedsGesture);
    button.classList.toggle('is-wait', supported && settings.fomoTranslate && translationNeedsGesture);
    button.title = !supported
      ? '当前浏览器不支持内置本地翻译'
      : translationNeedsGesture
        ? '点一下下载中文语言包，之后自动翻译全部观点'
        : settings.fomoTranslate ? '关闭中文翻译' : '开启中文翻译';
  }

  async function translatorFor(lang) {
    if (!lang || lang === 'zh' || !globalThis.Translator) return null;
    if (translators.has(lang)) return translators.get(lang);
    const api = globalThis.Translator;
    let availability = 'available';
    try {
      if (typeof api.availability === 'function') {
        availability = String(await api.availability({ sourceLanguage: lang, targetLanguage: 'zh' }) || 'available');
      }
    } catch {
      availability = 'available';
    }
    if (availability === 'unavailable') return null;
    if (availability !== 'available' && !translationGesture) {
      translationPendingLangs.add(lang);
      translationNeedsGesture = true;
      syncTranslationButton();
      return null;
    }
    let instance;
    try {
      instance = await api.create({ sourceLanguage: lang, targetLanguage: 'zh' });
    } catch {
      translationPendingLangs.add(lang);
      translationNeedsGesture = true;
      syncTranslationButton();
      return null;
    }
    translators.set(lang, instance);
    translationPendingLangs.delete(lang);
    translationNeedsGesture = false;
    syncTranslationButton();
    return instance;
  }

  /** 首次语言包下载要求真实点击手势，所以 create() 不能等异步语言检测之后才调用。 */
  function primeTranslatorFromGesture(lang) {
    const api = globalThis.Translator;
    if (!api || !lang || lang === 'zh' || translators.has(lang)) return;
    try {
      const pending = api.create({ sourceLanguage: lang, targetLanguage: 'zh' })
        .then((instance) => {
          translators.set(lang, instance);
          translationPendingLangs.delete(lang);
          translationNeedsGesture = false;
          syncTranslationButton();
          return instance;
        })
        .catch(() => {
          translators.delete(lang);
          translationPendingLangs.add(lang);
          translationNeedsGesture = true;
          syncTranslationButton();
          return null;
        });
      translators.set(lang, pending);
    } catch {
      translationPendingLangs.add(lang);
      translationNeedsGesture = true;
      syncTranslationButton();
    }
  }

  function primeVisibleTranslators(root) {
    const langs = new Set(['en', ...translationPendingLangs]);
    root?.querySelectorAll('.gdh-debot-fomo__text').forEach((node) => {
      const lang = translationFallbackLang(translationForeignProbe(node.textContent));
      if (lang) langs.add(lang);
    });
    langs.forEach(primeTranslatorFromGesture);
  }

  function paintTranslatedText(element, translated) {
    if (!translated || !element?.parentNode) return;
    let zh = element.nextElementSibling;
    if (!zh || !zh.classList.contains('gdh-debot-fomo__zh')) {
      zh = document.createElement('div');
      zh.className = 'gdh-debot-fomo__zh';
      element.after(zh);
    }
    zh.textContent = translated;
  }

  async function translateText(element, text) {
    const raw = safeText(text, 1500);
    if (!settings.fomoTranslate || !raw || !translationForeignProbe(raw) || !globalThis.Translator) return;
    try {
      let translated = translationCache.get(raw);
      if (!translated) {
        const lang = await detectTranslationLanguage(raw);
        const translator = await translatorFor(lang);
        if (!translator) return;
        translated = safeText(await translator.translate(raw), 1500);
        if (translated) {
          translationCache.set(raw, translated);
          while (translationCache.size > 300) translationCache.delete(translationCache.keys().next().value);
        }
      }
      paintTranslatedText(element, translated);
    } catch {
      // 浏览器没有语言包或要求用户手势时保留原文。
    }
  }

  function renderHolders(list, items) {
    list.replaceChildren();
    pnlObserver?.disconnect();
    pnlObserver = null;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-debot-fomo__empty';
      empty.textContent = '暂无持仓者';
      return void list.appendChild(empty);
    }
    for (const item of items.slice(0, 60)) {
      const row = document.createElement('article');
      row.className = 'gdh-debot-fomo__holder';
      const head = panelHeader(item);
      const userId = fomoUser(item)?.id;
      if (userId) {
        const tag = document.createElement('span');
        tag.className = 'gdh-debot-fomo__pnl-tag is-loading';
        tag.textContent = '…';
        head.appendChild(tag);
        watchPnl(tag, userId, list);
      }
      row.appendChild(head);

      const numbers = document.createElement('div');
      numbers.className = 'gdh-debot-fomo__numbers';
      const value = Number(item?.value ?? deepPick(item, /(position|value|balance)(usd)?$/i, 'number'));
      const pnl = Number(item?.pnl ?? item?.realizedPnl ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number'));
      const basis = Number(item?.costBasis);
      const entry = Number(item?.averageEntryPrice ?? deepPick(item, /(entry|average).*(price)/i, 'number'));
      const position = document.createElement('strong');
      position.textContent = value > 0 ? fomoUsd(value) : '—';
      const profit = document.createElement('span');
      profit.className = pnl >= 0 ? 'is-up' : 'is-down';
      const rate = basis > 0 ? pnl / basis * 100 : NaN;
      profit.textContent = Number.isFinite(pnl) && pnl !== 0
        ? `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}${Number.isFinite(rate) ? ` (${rate > 0 ? '+' : ''}${rate.toFixed(1)}%)` : ''}` : '—';
      const average = document.createElement('span');
      average.textContent = fomoPrice(entry) || '—';
      numbers.append(position, profit, average);
      row.appendChild(numbers);

      const thesis = safeText(item?.comment?.comment
        || deepPick(item, /(thesis|content|message|note|comment)/i, 'string'), 1500);
      if (thesis) {
        const text = document.createElement('p');
        text.className = 'gdh-debot-fomo__text';
        text.textContent = thesis;
        row.appendChild(text);
        translateText(text, thesis);
      }
      list.appendChild(row);
    }
  }

  function renderItems(list, items, kind) {
    if (kind === 'holders') return renderHolders(list, items);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-debot-fomo__empty';
      empty.textContent = kind === 'thesis' ? '还没有人发表观点' : '暂无交易';
      return void list.appendChild(empty);
    }
    for (const item of items.slice(0, 50)) {
      const row = document.createElement('article');
      row.className = 'gdh-debot-fomo__item';
      const head = panelHeader(item);
      const trade = item?.authorTrade;
      const pnl = Number(trade
        ? (trade.closedAt ? trade.realizedPnlUsd : Number(trade.realizedPnlUsd || 0) + Number(trade.unrealizedPnlUsd || 0))
        : (item?.pnlChange ?? deepPick(item, /(pnl|profit)(usd)?$/i, 'number')));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const value = document.createElement('span');
        value.className = `gdh-debot-fomo__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        value.textContent = `${pnl >= 0 ? '+' : ''}${fomoUsd(pnl)}`;
        head.appendChild(value);
      }
      const timeValue = item?.createdAt || item?.timestamp || item?.createdTime || item?.time;
      const timeMs = Number(new Date(timeValue));
      const time = document.createElement('time');
      time.textContent = Number.isFinite(timeMs) ? relativeTime(timeMs) : '';
      head.appendChild(time);
      row.appendChild(head);
      const textValue = safeText(item?.comment?.comment
        || deepPick(item, /(thesis|content|text|body|message|note)/i, 'string'), 1500);
      if (textValue) {
        const text = document.createElement('p');
        text.className = 'gdh-debot-fomo__text';
        text.textContent = textValue;
        row.appendChild(text);
        translateText(text, textValue);
      }
      list.appendChild(row);
    }
  }

  function renderPanelStats() {
    if (!panel) return;
    const container = panel.querySelector('.gdh-debot-fomo__stats');
    const holders = panelStats.holders;
    container.replaceChildren();
    if (!holders) return;
    const total = Number(holders.total) > 0 ? Number(holders.total) : holders.items.length;
    const sumUsd = holders.items.reduce((sum, item) => sum + (Number(item?.value) || 0), 0);
    const sumAmount = holders.items.reduce((sum, item) => sum + holderAmount(item), 0);
    const share = panelStats.supply > 0 ? sumAmount / panelStats.supply * 100 : NaN;
    const values = [
      ['Fomo 持有人数', String(total), `已加载 ${holders.items.length}`],
      ['Fomo 持仓占比', Number.isFinite(share) ? `≥${share.toFixed(1)}%` : '—', `合计 ${fomoUsd(sumUsd) || '$0'}`],
    ];
    for (const [label, value, sub] of values) {
      const block = document.createElement('div');
      block.className = 'gdh-debot-fomo__stat';
      const labelNode = document.createElement('span');
      labelNode.textContent = label;
      const valueNode = document.createElement('strong');
      valueNode.textContent = value;
      const subNode = document.createElement('small');
      subNode.textContent = sub;
      block.append(labelNode, valueNode, subNode);
      container.appendChild(block);
    }
  }

  async function loadDebotTokenSupply(route) {
    const key = `${route.chain}|${route.address}`;
    const cached = debotSupplyCache.get(key);
    if (cached && Date.now() - cached.savedAt < 10 * 60 * 1000) return cached.supply;
    try {
      const url = new URL('/api/dashboard/token/detail', location.origin);
      url.searchParams.set('chain', route.chain);
      url.searchParams.set('token', route.address);
      url.searchParams.set('request_id', `gdh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return 0;
      const body = await response.json();
      if (body?.code !== 0 && body?.code !== 200) return 0;
      const pair = body?.data?.pair;
      const responseAddress = normalizeAddress(pair?.tokenAddress);
      if (responseAddress && responseAddress !== normalizeAddress(route.address)) return 0;
      const supply = Number(pair?.totalSupply);
      if (!Number.isFinite(supply) || supply <= 0) return 0;
      debotSupplyCache.set(key, { savedAt: Date.now(), supply });
      if (debotSupplyCache.size > 80) debotSupplyCache.delete(debotSupplyCache.keys().next().value);
      return supply;
    } catch {
      return 0;
    }
  }

  async function loadPanelStats(route) {
    const key = `${route.chain}|${route.address}`;
    if (panelStats.key === key && panelStats.holders) return;
    panelStats = { key, holders: null, thesisCount: null, supply: 0 };
    const [holders, thesis, debotSupply, fallbackSupply] = await Promise.all([
      runtimeMessage({ type: 'fomo-token-feed', payload: { tokenAddress: route.address, networkId: route.networkId, kind: 'holders' } }),
      runtimeMessage({ type: 'fomo-token-feed', payload: { tokenAddress: route.address, networkId: route.networkId, kind: 'thesis' } }),
      loadDebotTokenSupply(route),
      runtimeMessage({ type: 'token-supply', payload: { chain: route.chain, address: route.address } }),
    ]);
    if (!panel || panelStats.key !== key) return;
    if (holders?.ok) panelStats.holders = { items: holders.items || [], total: Number(holders.total) };
    if (thesis?.ok) panelStats.thesisCount = (thesis.items || []).length;
    if (Number(debotSupply) > 0) panelStats.supply = Number(debotSupply);
    else if (fallbackSupply?.ok && Number(fallbackSupply.supply) > 0) panelStats.supply = Number(fallbackSupply.supply);
    renderPanelStats();
  }

  function loginGuide(list, response) {
    list.replaceChildren();
    const box = document.createElement('div');
    box.className = 'gdh-debot-fomo__guide';
    const title = document.createElement('strong');
    title.className = 'gdh-debot-fomo__guide-title';
    const reason = String(response?.reason || 'unknown');
    const needsLogin = reason === 'no-token' || reason === 'expired';
    title.textContent = reason === 'no-token'
      ? '需要登录 fomo'
      : (reason === 'expired' ? 'fomo 登录已失效' : `加载失败（${safeText(reason, 40)}）`);
    const note = document.createElement('p');
    note.textContent = reason === 'no-token'
      ? '持仓者、观点和交易数据需要登录后读取；插件尚未拿到浏览器里的 fomo 登录态。'
      : reason === 'expired'
        ? '已保存的登录态失效，自动续期没有成功。重新进入 fomo 登录一次即可恢复。'
      : safeText(response?.message || '请稍后重试', 120);
    box.append(title, note);
    if (needsLogin) {
      const steps = document.createElement('ol');
      steps.className = 'gdh-debot-fomo__guide-steps';
      [
        ['打开 fomo', '点击下方按钮，会在新标签页打开'],
        ['确认已登录', '未登录就完成登录；已经登录则刷新一次页面'],
        ['返回 DeBot', '插件会自动同步，不需要复制任何令牌'],
      ].forEach(([main, sub]) => {
        const item = document.createElement('li');
        const label = document.createElement('b');
        const detail = document.createElement('span');
        label.textContent = main;
        detail.textContent = sub;
        item.append(label, detail);
        steps.appendChild(item);
      });
      box.appendChild(steps);
      const actions = document.createElement('div');
      actions.className = 'gdh-debot-fomo__guide-actions';
      const open = document.createElement('a');
      open.className = 'gdh-debot-fomo__guide-open';
      open.href = 'https://fomo.family/';
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = '打开 fomo 并登录 →';
      open.addEventListener('click', (event) => {
        event.preventDefault();
        window.open('https://fomo.family/r/Unipioneer', '_blank', 'noopener,noreferrer');
      });
      actions.appendChild(open);
      box.appendChild(actions);
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'gdh-debot-fomo__guide-retry';
    retry.textContent = '重试';
    retry.addEventListener('click', () => { panelLoadedKey = ''; loadPanel(true); });
    const actions = box.querySelector('.gdh-debot-fomo__guide-actions');
    if (actions) actions.appendChild(retry);
    else box.appendChild(retry);
    list.appendChild(box);
  }

  async function loadPanel(force = false) {
    const route = debotTokenRoute();
    if (!route || !panel || panelLoading) return;
    const key = `${panelTab}|${route.chain}|${route.address}`;
    if (!force && panelLoadedKey === key) return;
    panelLoading = true;
    const list = panel.querySelector('.gdh-debot-fomo__list');
    list.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'gdh-debot-fomo__empty';
    loading.textContent = '加载中…';
    list.appendChild(loading);
    const response = await runtimeMessage({
      type: 'fomo-token-feed',
      payload: { tokenAddress: route.address, networkId: route.networkId, kind: panelTab },
    });
    panelLoading = false;
    if (!panel || debotTokenRoute()?.address !== route.address) return;
    if (!response?.ok) return void loginGuide(list, response);
    panelLoadedKey = key;
    panelItems = Array.isArray(response.items) ? response.items : [];
    if (panelTab === 'holders') panelStats.holders = { items: panelItems, total: Number(response.total) };
    if (panelTab === 'thesis') panelStats.thesisCount = panelItems.length;
    renderPanelStats();
    renderItems(list, panelItems, panelTab);
    loadPanelStats(route);
  }

  function positionPanel() {
    const position = settings.debotFomoPanelPos;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 160, position.x))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, position.y))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.right = '16px';
      panel.style.top = '96px';
      panel.style.left = 'auto';
    }
  }

  function makePanelDraggable(handle) {
    let dragging = false; let startX = 0; let startY = 0; let originX = 0; let originY = 0;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true; startX = event.clientX; startY = event.clientY; originX = rect.left; originY = rect.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 160, originX + event.clientX - startX))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, originY + event.clientY - startY))}px`;
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = panel.getBoundingClientRect();
      settings.debotFomoPanelPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
      chrome.storage.local.set({ debotFomoPanelPos: settings.debotFomoPanelPos });
    });
  }

  function buildPanel() {
    const root = document.createElement('section');
    root.className = 'gdh-debot-fomo';
    const bar = document.createElement('header');
    bar.className = 'gdh-debot-fomo__bar';
    const title = document.createElement('strong');
    title.className = 'gdh-debot-fomo__title';
    title.textContent = 'fomo';
    const tabs = document.createElement('nav');
    tabs.className = 'gdh-debot-fomo__tabs';
    for (const [id, label] of [['holders', '持仓者'], ['thesis', '观点'], ['swaps', '交易']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tab = id;
      button.textContent = label;
      button.classList.toggle('is-active', panelTab === id);
      button.addEventListener('click', () => {
        panelTab = id;
        root.querySelectorAll('.gdh-debot-fomo__tabs button').forEach((tab) => {
          tab.classList.toggle('is-active', tab.dataset.tab === id);
        });
        panelLoadedKey = '';
        loadPanel(true);
      });
      tabs.appendChild(button);
    }
    const translate = document.createElement('button');
    translate.type = 'button';
    translate.className = 'gdh-debot-fomo__translate';
    translate.textContent = '译';
    translate.addEventListener('click', () => {
      if (settings.fomoTranslate && translationNeedsGesture) {
        translationGesture = true;
        translationNeedsGesture = false;
        translators.clear();
        primeVisibleTranslators(root);
        syncTranslationButton();
        renderItems(root.querySelector('.gdh-debot-fomo__list'), panelItems, panelTab);
        return;
      }
      settings.fomoTranslate = !settings.fomoTranslate;
      if (settings.fomoTranslate) {
        translationGesture = true;
        primeVisibleTranslators(root);
      }
      chrome.storage.local.set({ fomoTranslate: settings.fomoTranslate });
      syncTranslationButton();
      renderItems(root.querySelector('.gdh-debot-fomo__list'), panelItems, panelTab);
    });
    const external = document.createElement('a');
    external.className = 'gdh-debot-fomo__external';
    external.target = '_blank';
    external.rel = 'noreferrer';
    external.textContent = '↗';
    external.title = '在 fomo.family 打开';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'gdh-debot-fomo__fold';
    fold.textContent = settings.debotFomoPanelFolded ? '▣' : '▤';
    fold.addEventListener('click', () => {
      settings.debotFomoPanelFolded = !settings.debotFomoPanelFolded;
      root.classList.toggle('is-folded', settings.debotFomoPanelFolded);
      fold.textContent = settings.debotFomoPanelFolded ? '▣' : '▤';
      chrome.storage.local.set({ debotFomoPanelFolded: settings.debotFomoPanelFolded });
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-debot-fomo__close';
    close.textContent = '×';
    close.addEventListener('click', () => {
      settings.debotFomoPanelOpen = false;
      chrome.storage.local.set({ debotFomoPanelOpen: false });
      syncPanel();
    });
    bar.append(title, tabs, translate, external, fold, close);
    const stats = document.createElement('div');
    stats.className = 'gdh-debot-fomo__stats';
    const list = document.createElement('div');
    list.className = 'gdh-debot-fomo__list';
    root.append(bar, stats, list);
    root.classList.toggle('is-folded', settings.debotFomoPanelFolded === true);
    makePanelDraggable(bar);
    queueMicrotask(syncTranslationButton);
    return root;
  }

  function syncPanel() {
    const route = debotTokenRoute();
    if (settings.enableFomoPanel === false || !route) {
      panelLauncher?.remove(); panelLauncher = null;
      panel?.remove(); panel = null;
      if (panelTimer) window.clearInterval(panelTimer);
      panelTimer = 0; panelLoadedKey = '';
      return;
    }
    if (!panelLauncher) {
      panelLauncher = document.createElement('button');
      panelLauncher.type = 'button';
      panelLauncher.className = 'gdh-debot-fomo-launcher';
      panelLauncher.textContent = 'fomo';
      panelLauncher.title = '查看该代币在 fomo 的持仓者、观点与交易';
      panelLauncher.addEventListener('click', () => {
        settings.debotFomoPanelOpen = !settings.debotFomoPanelOpen;
        chrome.storage.local.set({ debotFomoPanelOpen: settings.debotFomoPanelOpen });
        syncPanel();
      });
      document.body.appendChild(panelLauncher);
    }
    panelLauncher.classList.toggle('is-active', settings.debotFomoPanelOpen === true);
    if (!settings.debotFomoPanelOpen) {
      panel?.remove(); panel = null; panelLoadedKey = '';
      if (panelTimer) window.clearInterval(panelTimer);
      panelTimer = 0;
      return;
    }
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
      positionPanel();
      panelLoadedKey = '';
    }
    const external = panel.querySelector('.gdh-debot-fomo__external');
    external.href = `https://fomo.family/tokens/${FOMO_CHAIN_SLUG[route.chain] || route.chain}/${encodeURIComponent(route.address)}`;
    loadPanel(false);
    if (!panelTimer) {
      panelTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') { panelLoadedKey = ''; loadPanel(true); }
      }, PANEL_REFRESH_MS);
    }
  }

  function syncRoute() {
    syncPanel();
    scheduleDebotRwaPoolScan();
    if (isTrackShellPage()) {
      pollFomo();
      pollPump();
      scheduleFeedLayout();
    } else {
      clearFeedLayout();
      clearSidebarFeedLayout();
    }
  }

  function start() {
    chrome.storage.local.get(DEFAULTS, (stored) => {
      settings = { ...DEFAULTS, ...stored };
      rebuildSpecialWalletMap();
      syncRoute();
    });
    chrome.storage.local.get({ monitorFomoConfig: null, monitorPumpConfig: null }, (stored) => {
      loadMonitorFomo(stored.monitorFomoConfig);
      loadMonitorPump(stored.monitorPumpConfig);
      scheduleFeedLayout();
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (key === 'monitorFomoConfig') loadMonitorFomo(change.newValue);
        else if (key === 'monitorPumpConfig') loadMonitorPump(change.newValue);
        else if (key === 'fomoToken') panelLoadedKey = '';
        else settings[key] = change.newValue;
      }
      if (changes.specialWallets) rebuildSpecialWalletMap();
      syncRoute();
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'gdh-fomo-push') pollFomo(true);
      if (message?.type === 'gdh-pump-push') pollPump(true);
    });
    document.addEventListener('gdh-debot-track-ready', scheduleFeedLayout);
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('resize', scheduleFeedLayout, { passive: true });
    window.addEventListener('resize', positionDebotRwaPopover, { passive: true });
    document.addEventListener('click', openDebotRwaPoolLink, true);
    document.addEventListener('keydown', openDebotRwaPoolLink, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncRoute();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!specialPalette || (event.target instanceof Node && specialPalette.contains(event.target))) return;
      closeSpecialPalette();
    }, true);
    document.addEventListener('scroll', (event) => {
      positionDebotRwaPopover();
      const table = trackTable();
      const scroller = trackScroller(table);
      const sidebarScroller = sidebarTrackLayout()?.scroller;
      if ((scroller && event.target === scroller) || event.target === sidebarScroller) scheduleFeedLayout();
    }, true);
    feedObserver = new MutationObserver((records) => {
      const isOwnedNode = (node) => node instanceof Element
        && (node.matches('[data-gdh-debot-fomo-key], .gdh-debot-feed__fallback, .gdh-debot-sidefeed__row, .gdh-debot-fomo, .gdh-debot-fomo-launcher, .gdh-debot-special-manage-button, .gdh-debot-special-manage, .gdh-debot-special-star, .gdh-debot-special-swatch, .gdh-debot-special-pin-strip, .gdh-debot-rwa-link, .gdh-debot-rwa-popover')
          || node.closest('[data-gdh-debot-fomo-key], .gdh-debot-feed__fallback, .gdh-debot-sidefeed__row, .gdh-debot-fomo, .gdh-debot-special-manage, .gdh-debot-special-pin-strip, .gdh-debot-rwa-popover'));
      if (records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target?.parentElement;
        if (target?.closest('.gdh-debot-fomo, [data-gdh-debot-fomo-key], .gdh-debot-feed__fallback, .gdh-debot-sidefeed__row, .gdh-debot-special-manage, .gdh-debot-special-pin-strip, .gdh-debot-rwa-popover')) return false;
        const changed = [...record.addedNodes, ...record.removedNodes];
        return changed.some((node) => node.nodeType !== Node.TEXT_NODE && !isOwnedNode(node));
      })) {
        syncPanel();
        scheduleFeedLayout();
        scheduleDebotRwaPoolScan();
      }
    });
    feedObserver.observe(document.documentElement, { childList: true, subtree: true });
    feedPollTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') { pollFomo(); pollPump(); }
    }, 3000);
    window.setInterval(() => {
      document.querySelectorAll('.gdh-debot-feed__time[data-gdh-ts], .gdh-debot-sidefeed__time[data-gdh-ts]').forEach((time) => {
        const next = relativeTime(time.dataset.gdhTs);
        if (time.textContent !== next) time.textContent = next;
      });
    }, 5000);
    syncRoute();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
