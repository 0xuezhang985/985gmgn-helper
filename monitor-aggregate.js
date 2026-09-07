(() => {
  'use strict';

  const MONITOR_SELECTOR = '[data-sentry-component="Monitor"]';
  const HOST_ATTR = 'data-gdh-monitor-content-host';
  const NAV_ATTR = 'data-gdh-nav';
  const CONFIG_ATTR = 'data-gdh-monitor-aggregate-enabled';
  const CONFIG_EVENT = 'gdh-monitor-config-changed';
  const CHART_HOLDINGS_SELECTOR = '.chart-anchor-main';
  const MAX_ROWS = 100;
  const SNAPSHOT_TTL_MS = 30_000;
  const LIVE_REFRESH_MIN_MS = 8_000;
  const CHART_HOLDINGS_TTL_MS = 30_000;
  const FALLBACK_CHAINS = [
    'sol',
    'bsc',
    'robinhood',
    'base',
    'eth',
    'arbitrum',
    'stable',
    'arc',
    'xlayer',
    'hyperevm',
    'megaeth',
    'monad',
  ];
  const CHAIN_LABELS = {
    sol: 'SOL',
    bsc: 'BSC',
    robinhood: 'Robinhood',
    base: 'Base',
    eth: 'ETH',
    arbitrum: 'Arbitrum',
    stable: 'Stable',
    arc: 'Arc',
    xlayer: 'X Layer',
    hyperevm: 'HyperEVM',
    megaeth: 'MegaETH',
    monad: 'Monad',
  };

  let webpackRequire = null;
  let apiFetchCards = null;
  let followSocket = null;
  let nativePrepareCard = null;
  let nativeFilterCards = null;
  let trackedHolderApi = null;
  let liveSubscription = null;
  let currentHost = null;
  let panel = null;
  let currentInterval = '1m';
  let requestGeneration = 0;
  let lastFullFetchAt = 0;
  let activeFetches = 0;
  let fullFetchRunning = false;
  let renderQueued = false;
  let scanTimer = 0;
  let destroyed = false;
  let currentNativeFilter = null;
  let currentFilterFingerprint = '';
  let chartHoldingsInflight = null;
  let chartHoldingsKey = '';
  let chartHoldingsFetchedAt = 0;
  const cardsByChain = new Map();
  const errorsByChain = new Map();
  const lastChainFetchAt = new Map();
  const chainRefreshTimers = new Map();
  const chainsFetching = new Set();
  const expandedKeys = new Set();

  const escapeHtml = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  function captureWebpackRequire() {
    if (webpackRequire?.m) return webpackRequire;
    const chunks = self.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return null;
    try {
      chunks.push([[Date.now() % 1_000_000_000], {}, (runtime) => {
        webpackRequire = runtime;
      }]);
    } catch {
      return null;
    }
    return webpackRequire?.m ? webpackRequire : null;
  }

  function discoverGmgnMonitorApi() {
    if (apiFetchCards && followSocket && nativePrepareCard && nativeFilterCards) return true;
    const req = captureWebpackRequire();
    if (!req) return false;
    try {
      if (!apiFetchCards) {
        const apiId = Object.keys(req.m).find((id) => {
          const source = String(req.m[id]);
          return source.includes('name:"follow_cards"') && source.includes('/api/v1/token_holder_counts');
        });
        if (apiId) {
          const apiModule = req(apiId);
          apiFetchCards = Object.values(apiModule).find(
            (value) => typeof value === 'function' && String(value).includes('monitorCardsV3'),
          );
        }
      }
      if (!followSocket) {
        const socketId = Object.keys(req.m).find((id) =>
          String(req.m[id]).includes('getQuotationSocketMgr:()=>'),
        );
        if (socketId) {
          const socketModule = req(socketId);
          const getManager = socketModule.getQuotationSocketMgr;
          followSocket = typeof getManager === 'function' ? getManager()?.getFollowWalletSocket?.() : null;
        }
      }
      if (!nativePrepareCard || !nativeFilterCards) {
        const filterId = Object.keys(req.m).find((id) => {
          const source = String(req.m[id]);
          return source.includes('is_open_or_close')
            && source.includes('walletCount')
            && source.includes('walletsAmountTotal')
            && source.includes('migrate_status');
        });
        if (filterId) {
          const filterModule = req(filterId);
          nativePrepareCard = Object.values(filterModule).find((value) => (
            typeof value === 'function'
            && String(value).includes('walletsAmountTotal')
            && String(value).includes('priceChangePercent')
            && !String(value).includes('rangeValueTimes')
          )) || null;
          nativeFilterCards = Object.values(filterModule).find((value) => (
            typeof value === 'function'
            && String(value).includes('rangeValueTimes')
            && String(value).includes('walletCount')
            && String(value).includes('migrate_status')
          )) || null;
        }
      }
    } catch {
      return false;
    }
    return typeof apiFetchCards === 'function' && !!followSocket
      && typeof nativePrepareCard === 'function' && typeof nativeFilterCards === 'function';
  }

  function discoverTrackedHolderApi() {
    if (trackedHolderApi) return true;
    const req = captureWebpackRequire();
    if (!req) return false;
    try {
      const holderId = Object.keys(req.m).find((id) => {
        const source = String(req.m[id]);
        return source.includes('/vas/api/v1/token_holders/');
      });
      if (!holderId) return false;
      const holderModule = req(holderId);
      trackedHolderApi = Object.values(holderModule).find((value) => {
        const source = String(value);
        return typeof value === 'function' && source.includes('/vas/api/v1/token_holders/');
      }) || null;
    } catch {
      trackedHolderApi = null;
    }
    return typeof trackedHolderApi === 'function';
  }

  function getChains() {
    const subscribed = followSocket?.subscribedChains;
    const found = subscribed && typeof subscribed[Symbol.iterator] === 'function' ? [...subscribed] : [];
    const chains = found.map((chain) => String(chain || '').toLowerCase()).filter(Boolean);
    return chains.length ? [...new Set(chains)] : FALLBACK_CHAINS;
  }

  function sanitizeWallet(wallet) {
    if (!wallet || typeof wallet !== 'object') return null;
    const side = String(wallet.side || '');
    const amountUsd = Math.abs(Number(wallet.amount_usd || 0));
    const isOutflow = ['sell', 'transfer_out', 'remove', 'burn'].includes(side);
    const netInflow = wallet.net_inflow !== undefined && wallet.net_inflow !== null
      ? Number(wallet.net_inflow || 0)
      : isOutflow ? -amountUsd : amountUsd;
    return {
      address: String(wallet.wallet_address || wallet.maker || wallet.maker_info_address || ''),
      name: String(wallet.twitter_name || wallet.nick_name || wallet.name || ''),
      username: String(wallet.twitter_username || ''),
      avatar: String(wallet.avatar || ''),
      balance: Number(wallet.balance || 0),
      netInflow,
      amountTotal: Math.abs(Number(wallet.amount_total || amountUsd || 0)),
      buys: Number(wallet.buys || 0),
      sells: Number(wallet.sells || 0),
      side,
      isOpenOrClose: Number(wallet.is_open_or_close),
      timestamp: Number(wallet.timestamp || wallet.balance_ts || 0),
    };
  }

  function sanitizeCard(chain, card) {
    if (!card || typeof card !== 'object') return null;
    const address = String(card.address || card.token_address || card.base_address || '');
    if (!address) return null;
    return {
      chain,
      address,
      symbol: String(card.symbol || card.base_symbol || '').trim() || '—',
      name: String(card.name || card.base_name || '').trim(),
      logo: String(card.logo || card.base_logo || ''),
      marketCap: Number(card.market_cap || 0),
      price: Number(card.price || card.price_usd || 0),
      totalSupply: Number(card.total_supply || card.base_total_supply || 0),
      volume: Number(card.volume || 0),
      holderCount: Number(card.holder_count || 0),
      launchpadPlatform: String(card.launchpad_platform || ''),
      migrateStatus: String(card.migrate_status || ''),
      buys: Number(card.buys || 0),
      sells: Number(card.sells || 0),
      createTimestamp: Number(card.create_timestamp || card.token_create_time || 0),
      openTimestamp: Number(card.open_timestamp || card.token_open_time || 0),
      wallets: (Array.isArray(card.wallets) ? card.wallets : []).map(sanitizeWallet).filter(Boolean),
    };
  }

  function cardKey(card) {
    return `${card.chain}:${card.address.toLowerCase()}`;
  }

  function latestCardTimestamp(card) {
    let latest = Math.max(card.createTimestamp || 0, card.openTimestamp || 0);
    for (const wallet of card.wallets) latest = Math.max(latest, wallet.timestamp || 0);
    return latest;
  }

  function netInflow(card) {
    return card.wallets.reduce((sum, wallet) => sum + (Number(wallet.netInflow) || 0), 0);
  }

  function isAggregateEnabled() {
    return document.documentElement.getAttribute(CONFIG_ATTR) !== '0';
  }

  function findCardFilter(value, chain, seen = new WeakSet(), depth = 0) {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return null;
    seen.add(value);
    if (value[chain]?.cardFilter && typeof value[chain].cardFilter === 'object') {
      return value[chain].cardFilter;
    }
    if (value.cardFilter && typeof value.cardFilter === 'object') return value.cardFilter;
    const children = Array.isArray(value) ? value : Object.entries(value)
      .filter(([key]) => ![
        'return', 'child', 'sibling', 'alternate', 'stateNode', 'memoizedProps', 'pendingProps',
      ].includes(key) && !key.startsWith('__react'))
      .slice(0, 50)
      .map(([, child]) => child);
    for (const child of children) {
      const filter = findCardFilter(child, chain, seen, depth + 1);
      if (filter) return filter;
    }
    return null;
  }

  function readNativeMonitorFilter(monitor) {
    const chain = String(
      monitor?.querySelector('[data-testid="chain-switch-current"]')?.getAttribute('data-chain') || '',
    ).toLowerCase();
    const trigger = monitor?.querySelector('[data-icon="IconFilter16pxRegular"]')?.closest('button');
    if (!chain || !trigger) return null;
    const fiberKey = Object.keys(trigger).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    let fiber = trigger[fiberKey];
    for (let level = 0; fiber && level < 55; level += 1) {
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 40; index += 1) {
        const filter = findCardFilter(hook.memoizedState, chain);
        if (filter) {
          try { return JSON.parse(JSON.stringify(filter)); } catch { return null; }
        }
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function applyNativeMonitorFilter(cards) {
    const prepared = typeof nativePrepareCard === 'function'
      ? cards.map((card) => nativePrepareCard(card)) : cards;
    if (!currentNativeFilter || typeof nativeFilterCards !== 'function') return prepared;
    try {
      return nativeFilterCards(prepared, [], currentNativeFilter, 'walletsAmountTotal') || [];
    } catch {
      return prepared;
    }
  }

  function hasActiveNativeFilter() {
    const filter = currentNativeFilter;
    return !!(
      filter?.volume?.min || filter?.volume?.max
      || filter?.marketCap?.min || filter?.marketCap?.max
      || filter?.netInflow?.min || filter?.netInflow?.max
      || filter?.walletCount?.min || filter?.walletCount?.max
      || filter?.holderCount?.min || filter?.holderCount?.max
      || filter?.tokenAge?.min || filter?.tokenAge?.max
      || filter?.dexs?.length || filter?.metrics?.length
      || (filter?.migrate_status && filter.migrate_status !== 'all')
    );
  }

  function compactNumber(value, { money = false } = {}) {
    const number = Number(value);
    if (!Number.isFinite(number)) return money ? '$0' : '0';
    const sign = number < 0 ? '-' : '';
    const amount = Math.abs(number);
    const units = [
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    let text;
    const unit = units.find(([size]) => amount >= size);
    if (unit) {
      const scaled = amount / unit[0];
      text = `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit[1]}`;
    } else {
      text = amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2);
    }
    text = text.replace(/\.0+(?=[KMB]?$)/, '').replace(/(\.\d*[1-9])0+(?=[KMB]?$)/, '$1');
    return `${sign}${money ? '$' : ''}${text}`;
  }

  function formatAge(timestamp) {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp || 0)));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86_400)}d`;
  }

  function sanitizeTrackedHolding(holder) {
    const balance = Number(holder?.balance || 0);
    const amountPercentage = Number(holder?.amount_percentage);
    if (!(balance > 0) || !(amountPercentage > 0)) return null;
    const address = String(holder.address || '');
    const name = String(
      holder.remark || holder.twitter_name || holder.name || holder.twitter_username
      || holder.ens || (address ? `${address.slice(0, 5)}…${address.slice(-4)}` : '追踪钱包'),
    );
    return {
      address,
      name,
      avatar: String(holder.avatar || ''),
      holdingPercent: amountPercentage * 100,
      profit: Number(holder.profit),
      profitPercent: Number(holder.profit_change),
    };
  }

  function extractTrackedHoldingRows(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.list)) return response.list;
    if (Array.isArray(response?.holders)) return response.holders;
    if (Array.isArray(response?.data?.list)) return response.data.list;
    if (Array.isArray(response?.data?.holders)) return response.data.holders;
    return Array.isArray(response?.data) ? response.data : [];
  }

  function formatHoldingPercent(value) {
    const percent = Number(value) * 100;
    if (!Number.isFinite(percent)) return '—';
    return `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}`.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1') + '%';
  }

  function formatSignedMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    const amount = Math.abs(number);
    const unit = amount >= 1e9 ? [1e9, 'B'] : amount >= 1e6 ? [1e6, 'M'] : amount >= 1e3 ? [1e3, 'K'] : [1, ''];
    const scaled = amount / unit[0];
    const text = `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}${unit[1]}`
      .replace(/\.0+(?=[KMB]?$)/, '').replace(/(\.\d*[1-9])0+(?=[KMB]?$)/, '$1');
    return `${number >= 0 ? '+' : '-'}$${text}`;
  }

  function formatSignedPercent(value) {
    const percent = Number(value) * 100;
    if (!Number.isFinite(percent)) return '—';
    const text = Math.abs(percent).toFixed(2)
      .replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
    return `${percent >= 0 ? '+' : '-'}${text}%`;
  }

  function currentTokenRoute() {
    const match = location.pathname.match(/^\/([^/]+)\/token\/([^/?#]+)/i);
    if (!match) return null;
    try {
      return { chain: decodeURIComponent(match[1]).toLowerCase(), address: decodeURIComponent(match[2]) };
    } catch {
      return null;
    }
  }

  function removeChartHoldings() {
    document.querySelector('.gdh-chart-tracked-holdings')?.remove();
  }

  function renderChartHoldings(holdings) {
    const anchor = document.querySelector(CHART_HOLDINGS_SELECTOR);
    const host = anchor?.parentElement;
    const rows = holdings.filter(Boolean).sort((a, b) => b.holdingPercent - a.holdingPercent).slice(0, 5);
    removeChartHoldings();
    if (!host) return;
    const element = document.createElement('div');
    element.className = 'gdh-chart-tracked-holdings';
    element.setAttribute('aria-label', '追踪持仓前五名');
    if (!rows.length) {
      element.classList.add('is-empty');
      element.innerHTML = '<b class="gdh-chart-tracked-title">追踪持仓</b><span>暂无追踪持仓</span>';
      host.appendChild(element);
      return;
    }
    element.innerHTML = `<b class="gdh-chart-tracked-title">追踪持仓</b>${rows.map((holding) => {
      const profitClass = Number(holding.profit) < 0 || Number(holding.profitPercent) < 0 ? 'is-negative' : 'is-positive';
      const title = `${holding.name} · 持仓 ${holding.holdingPercent}% · 盈利 ${holding.profit} · ${holding.profitPercent}`;
      return `<span class="gdh-chart-tracked-holder" title="${escapeHtml(title)}">
        ${holding.avatar ? `<img src="${escapeHtml(holding.avatar)}" alt="">` : ''}
        <b>${escapeHtml(holding.name)}</b>
        <em>${holding.holdingPercent >= 10 ? holding.holdingPercent.toFixed(1) : holding.holdingPercent.toFixed(2)}%</em>
        <i class="${profitClass}">${formatSignedMoney(holding.profit)} (${formatSignedPercent(holding.profitPercent)})</i>
      </span>`;
    }).join('')}`;
    host.appendChild(element);
  }

  async function refreshChartHoldings(route, key) {
    try {
      const response = await trackedHolderApi(route.chain, route.address, {
        limit: 5,
        cost: 20,
        orderby: 'amount_percentage',
        direction: 'desc',
        following: true,
      });
      if (key !== chartHoldingsKey || key !== `${route.chain}:${route.address}`) return;
      const candidates = extractTrackedHoldingRows(response);
      renderChartHoldings(candidates.map(sanitizeTrackedHolding).filter(Boolean));
    } catch {
      if (key === chartHoldingsKey) removeChartHoldings();
    } finally {
      if (key === chartHoldingsKey) chartHoldingsFetchedAt = Date.now();
    }
  }

  function scanChartHoldings() {
    const route = currentTokenRoute();
    const anchor = document.querySelector(CHART_HOLDINGS_SELECTOR);
    if (!route || !anchor) {
      chartHoldingsKey = '';
      chartHoldingsFetchedAt = 0;
      removeChartHoldings();
      return;
    }
    const key = `${route.chain}:${route.address}`;
    if (key !== chartHoldingsKey) {
      chartHoldingsKey = key;
      chartHoldingsFetchedAt = 0;
      chartHoldingsInflight = null;
      removeChartHoldings();
    }
    if (chartHoldingsInflight || Date.now() - chartHoldingsFetchedAt < CHART_HOLDINGS_TTL_MS) return;
    if (!discoverTrackedHolderApi()) return;
    const request = refreshChartHoldings(route, key);
    chartHoldingsInflight = request;
    request.finally(() => {
      if (chartHoldingsInflight === request) chartHoldingsInflight = null;
    });
  }

  function aggregateRows() {
    return [...cardsByChain.values()]
      .flat()
      .sort((a, b) => latestCardTimestamp(b) - latestCardTimestamp(a))
      .slice(0, MAX_ROWS);
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function chainBadgeUrl(chain) {
    return `/static/img/${encodeURIComponent(chain)}.svg`;
  }

  function renderWallets(card) {
    const wallets = [...card.wallets].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
    if (!wallets.length) return '';
    const rows = wallets
      .map((wallet) => {
        const name = wallet.name || wallet.username || `${wallet.address.slice(0, 5)}…${wallet.address.slice(-4)}`;
        const sideClass = wallet.side === 'sell' ? 'is-negative' : 'is-positive';
        const side = wallet.side === 'sell' ? '卖出' : wallet.side === 'buy' ? '买入' : '活动';
        const inflow = Number(wallet.netInflow) || 0;
        return `<div class="gdh-monitor-wallet-row">
          <span class="gdh-monitor-wallet-person">${wallet.avatar ? `<img src="${escapeHtml(wallet.avatar)}" alt="">` : '<i></i>'}<span title="${escapeHtml(name)}">${escapeHtml(name)}</span></span>
          <span class="${sideClass}">${side}</span>
          <span class="${inflow < 0 ? 'is-negative' : 'is-positive'}">${inflow >= 0 ? '+' : ''}${compactNumber(inflow, { money: true })}</span>
          <time>${formatAge(wallet.timestamp)}</time>
        </div>`;
      })
      .join('');
    return `<div class="gdh-monitor-wallets">${rows}</div>`;
  }

  function renderRow(card) {
    const key = cardKey(card);
    const expanded = expandedKeys.has(key);
    const inflow = netInflow(card);
    const walletCount = card.wallets.length;
    const marketCap = card.marketCap || card.price * card.totalSupply;
    const href = `/${encodeURIComponent(card.chain)}/token/${encodeURIComponent(card.address)}`;
    const chainLabel = CHAIN_LABELS[card.chain] || card.chain;
    return `<div class="gdh-monitor-row-wrap" data-gdh-monitor-key="${escapeHtml(key)}">
      <div class="gdh-monitor-row">
        <div class="gdh-monitor-token-cell">
          <button type="button" class="gdh-monitor-expand${expanded ? ' is-expanded' : ''}" aria-label="${expanded ? '收起' : '展开'}钱包" ${walletCount ? '' : 'disabled'}>⌄</button>
          <a href="${escapeHtml(href)}" data-gdh-monitor-token-link>
            <span class="gdh-monitor-avatar">
              ${card.logo ? `<img src="${escapeHtml(card.logo)}" alt="">` : '<i></i>'}
              <img class="gdh-monitor-chain" src="${chainBadgeUrl(card.chain)}" alt="${escapeHtml(chainLabel)}" title="${escapeHtml(chainLabel)}">
            </span>
            <span class="gdh-monitor-symbol" title="${escapeHtml(`${card.symbol} · ${chainLabel}`)}">${escapeHtml(card.symbol)}</span>
          </a>
        </div>
        <div class="gdh-monitor-market">${compactNumber(marketCap, { money: true })}</div>
        <div class="gdh-monitor-swaps"><b>${compactNumber(card.buys)}</b><span>/</span><em>${compactNumber(card.sells)}</em></div>
        <div class="gdh-monitor-inflow"><small>♙ ${walletCount}</small><span class="${inflow < 0 ? 'is-negative' : 'is-positive'}">${inflow >= 0 ? '+' : ''}${compactNumber(inflow, { money: true })}</span></div>
        <div class="gdh-monitor-time"><span>${formatAge(latestCardTimestamp(card))}</span><small>活动</small></div>
      </div>
      ${expanded ? renderWallets(card) : ''}
    </div>`;
  }

  function render() {
    if (!panel?.isConnected) return;
    const rows = aggregateRows();
    const populatedChains = [...cardsByChain.values()].filter((cards) => cards.length).length;
    const totalChains = getChains().length;
    const loading = activeFetches > 0;
    const errors = errorsByChain.size;
    panel.innerHTML = `<div class="gdh-monitor-titlebar">
      <span><b>全链聚合</b><small>${populatedChains}/${totalChains} 链 · ${rows.length} 币</small></span>
      <button type="button" class="gdh-monitor-refresh${loading ? ' is-loading' : ''}" title="刷新全链监控" aria-label="刷新全链监控">↻</button>
    </div>
    <div class="gdh-monitor-head">
      <span>币种/钱包</span><span>市值/余额</span><span>${escapeHtml(currentInterval)} 交易数</span><span>${escapeHtml(currentInterval)} 净流入</span><span>时间</span>
    </div>
    <div class="gdh-monitor-list">
      ${rows.map(renderRow).join('') || `<div class="gdh-monitor-empty">${loading ? '正在汇总各链监控…' : errors ? '全链监控读取失败，请点右上角重试' : '当前关注钱包暂无监控数据'}</div>`}
    </div>`;
  }

  function findContentHost(monitor) {
    return [...monitor.children].find(
      (element) => element.classList.contains('flex-1') && element.classList.contains('min-h-0'),
    ) || null;
  }

  function ensurePanel(host) {
    if (currentHost !== host) {
      currentHost?.removeAttribute(HOST_ATTR);
      currentHost = host;
      currentHost.setAttribute(HOST_ATTR, '1');
    }
    if (!panel?.isConnected || panel.parentElement !== host) {
      panel?.remove();
      panel = document.createElement('div');
      panel.className = 'gdh-monitor-aggregate';
      panel.dataset.gdhMonitorAggregate = '1';
      host.appendChild(panel);
      bindPanelEvents(panel);
      queueRender();
    }
    return true;
  }

  function bindPanelEvents(element) {
    element.addEventListener('click', (event) => {
      const refresh = event.target.closest('.gdh-monitor-refresh');
      if (refresh) {
        fetchAllChains(true);
        return;
      }
      const expand = event.target.closest('.gdh-monitor-expand');
      if (expand && !expand.disabled) {
        const row = expand.closest('[data-gdh-monitor-key]');
        const key = row?.dataset.gdhMonitorKey;
        if (key) {
          expandedKeys.has(key) ? expandedKeys.delete(key) : expandedKeys.add(key);
          queueRender();
        }
        return;
      }
      const link = event.target.closest('[data-gdh-monitor-token-link]');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      const url = link.getAttribute('href');
      if (!url) return;
      document.documentElement.setAttribute(NAV_ATTR, url);
      document.dispatchEvent(new Event('gdh-navigate'));
    });
  }

  function installLiveSubscription() {
    if (liveSubscription || !followSocket?.getFollowWalletShareObservable) return;
    try {
      liveSubscription = followSocket.getFollowWalletShareObservable().subscribe({
        next(value) {
          const events = Array.isArray(value) ? value : [value];
          for (const event of events) applyLiveEvent(event);
        },
        error() {
          liveSubscription = null;
        },
      });
    } catch {
      liveSubscription = null;
    }
  }

  function stopLiveSubscription() {
    liveSubscription?.unsubscribe?.();
    liveSubscription = null;
    for (const timer of chainRefreshTimers.values()) window.clearTimeout(timer);
    chainRefreshTimers.clear();
  }

  function applyLiveEvent(event) {
    const chain = String(event?.chain || '').toLowerCase();
    if (chain && hasActiveNativeFilter()) {
      scheduleChainRefresh(chain);
      return;
    }
    const incoming = sanitizeCard(chain, event);
    if (!chain || !incoming) return;
    const cards = cardsByChain.get(chain) || [];
    const key = cardKey(incoming);
    const index = cards.findIndex((card) => cardKey(card) === key);
    const wallet = sanitizeWallet(event);
    if (index >= 0) {
      const old = cards[index];
      const wallets = [...old.wallets];
      if (wallet?.address) {
        const walletIndex = wallets.findIndex((item) => item.address.toLowerCase() === wallet.address.toLowerCase());
        walletIndex >= 0 ? wallets.splice(walletIndex, 1, wallet) : wallets.unshift(wallet);
      }
      const side = String(event.side || '');
      cards[index] = {
        ...old,
        logo: incoming.logo || old.logo,
        symbol: incoming.symbol !== '—' ? incoming.symbol : old.symbol,
        price: incoming.price || old.price,
        totalSupply: incoming.totalSupply || old.totalSupply,
        buys: old.buys + (side === 'buy' ? 1 : 0),
        sells: old.sells + (side === 'sell' ? 1 : 0),
        wallets,
      };
    } else {
      incoming.wallets = wallet ? [wallet] : [];
      incoming.buys = event.side === 'buy' ? 1 : 0;
      incoming.sells = event.side === 'sell' ? 1 : 0;
      cards.unshift(incoming);
    }
    if (cards.length > MAX_ROWS) cards.length = MAX_ROWS;
    cardsByChain.set(chain, cards);
    queueRender();
    scheduleChainRefresh(chain);
  }

  function scheduleChainRefresh(chain) {
    if (chainRefreshTimers.has(chain) || chainsFetching.has(chain)) return;
    const elapsed = Date.now() - (lastChainFetchAt.get(chain) || 0);
    const delay = Math.max(900, LIVE_REFRESH_MIN_MS - elapsed);
    const timer = window.setTimeout(() => {
      chainRefreshTimers.delete(chain);
      if (currentHost?.isConnected) fetchChain(chain, currentInterval, requestGeneration);
    }, delay);
    chainRefreshTimers.set(chain, timer);
  }

  async function fetchChain(chain, interval, generation) {
    if (chainsFetching.has(chain)) return;
    chainsFetching.add(chain);
    activeFetches += 1;
    queueRender();
    try {
      const response = await apiFetchCards({ type: 'follow', network: chain, interval });
      if (generation !== requestGeneration || interval !== currentInterval) return;
      const cards = applyNativeMonitorFilter(Array.isArray(response?.cards) ? response.cards : [])
        .map((card) => sanitizeCard(chain, card))
        .filter(Boolean)
        .slice(0, MAX_ROWS);
      cardsByChain.set(chain, cards);
      errorsByChain.delete(chain);
    } catch (error) {
      if (generation !== requestGeneration) return;
      errorsByChain.set(chain, Number(error?.response?.status) || String(error?.message || error));
    } finally {
      lastChainFetchAt.set(chain, Date.now());
      chainsFetching.delete(chain);
      activeFetches = Math.max(0, activeFetches - 1);
      queueRender();
    }
  }

  async function fetchAllChains(force = false) {
    if (fullFetchRunning && !force) return;
    if (!discoverGmgnMonitorApi()) {
      restoreNative();
      return;
    }
    const now = Date.now();
    if (!force && lastFullFetchAt && now - lastFullFetchAt < SNAPSHOT_TTL_MS) {
      installLiveSubscription();
      queueRender();
      return;
    }
    lastFullFetchAt = now;
    requestGeneration += 1;
    const generation = requestGeneration;
    fullFetchRunning = true;
    const chains = getChains();
    errorsByChain.clear();
    if (force) cardsByChain.clear();
    queueRender();
    let cursor = 0;
    const worker = async () => {
      while (cursor < chains.length && generation === requestGeneration) {
        const chain = chains[cursor++];
        await fetchChain(chain, currentInterval, generation);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, chains.length) }, worker));
      installLiveSubscription();
    } finally {
      if (generation === requestGeneration) fullFetchRunning = false;
    }
  }

  function readInterval(root) {
    const match = String(root?.textContent || '').match(/\b(1m|5m|15m|1h|6h|24h)\s*(?:交易数|Tx)/i);
    return match?.[1] || '1m';
  }

  function restoreNative() {
    const wasActive = !!(currentHost || panel || liveSubscription);
    if (wasActive) {
      requestGeneration += 1;
      fullFetchRunning = false;
      stopLiveSubscription();
    }
    currentHost?.removeAttribute(HOST_ATTR);
    panel?.remove();
    panel = null;
    currentHost = null;
  }

  function scan() {
    if (destroyed) return;
    scanChartHoldings();
    const monitor = document.querySelector(MONITOR_SELECTOR);
    const monitorTab = monitor && [...monitor.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent.trim() === '监控' || tab.textContent.trim().toLowerCase() === 'monitor');
    const host = monitor ? findContentHost(monitor) : null;
    if (!isAggregateEnabled() || !monitor || monitorTab?.getAttribute('aria-selected') !== 'true' || !host) {
      restoreNative();
      return;
    }
    if (!discoverGmgnMonitorApi()) {
      restoreNative();
      return;
    }
    const interval = readInterval(monitor);
    const intervalChanged = interval !== currentInterval;
    const nextFilter = readNativeMonitorFilter(monitor);
    const nextFilterFingerprint = nextFilter ? JSON.stringify(nextFilter) : currentFilterFingerprint;
    const filterChanged = !!nextFilter && nextFilterFingerprint !== currentFilterFingerprint;
    if (nextFilter) {
      currentNativeFilter = nextFilter;
      currentFilterFingerprint = nextFilterFingerprint;
    }
    const entering = currentHost !== host || !panel?.isConnected;
    currentInterval = interval;
    if (!ensurePanel(host)) return;
    installLiveSubscription();
    if (intervalChanged || filterChanged) {
      cardsByChain.clear();
      lastFullFetchAt = 0;
      fetchAllChains(true);
    } else if (entering || !lastFullFetchAt) {
      fetchAllChains(false);
    }
  }

  function start() {
    if (scanTimer) return;
    scan();
    scanTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') scan();
    }, 1_000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopLiveSubscription();
    else scan();
  });

  document.addEventListener(CONFIG_EVENT, scan);

  window.addEventListener('pagehide', () => {
    destroyed = true;
    if (scanTimer) window.clearInterval(scanTimer);
    stopLiveSubscription();
    restoreNative();
  }, { once: true });
})();
