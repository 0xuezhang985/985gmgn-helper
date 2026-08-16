(() => {
  'use strict';

  if (window.__gdhContentStarted) return;
  window.__gdhContentStarted = true;

  // 在 fomo.family 上只做一件事：把你已登录的 fomo 访问令牌交给插件，
  // 供 GMGN 代币页的 fomo 浮窗读取该代币的观点/交易（fomo 接口必须带 Bearer）。
  // 令牌只存在浏览器本地，只会发给 fomo 自己的 API，不外传；之后不跑任何 GMGN 逻辑。
  if (location.hostname === 'fomo.family' || location.hostname.endsWith('.fomo.family')) {
    const readPrivyToken = () => {
      try {
        const raw = window.localStorage.getItem('privy:token');
        if (!raw) return '';
        let token = raw;
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed === 'string') token = parsed;
        } catch {
          // 非 JSON 就按原样用
        }
        token = String(token || '').trim();
        return token.length > 20 ? token : '';
      } catch {
        return '';
      }
    };
    let lastSent = null;
    const syncFomoToken = () => {
      const token = readPrivyToken();
      if (token === lastSent) return;
      lastSent = token;
      try {
        chrome.storage.local.set({ fomoToken: token ? { token, at: Date.now() } : null });
      } catch {
        // 扩展上下文失效
      }
    };
    syncFomoToken();
    window.setInterval(syncFomoToken, 20000);
    window.addEventListener('focus', syncFomoToken);
    return;
  }

  const CARD_SELECTOR =
    '[data-sentry-source-file="TokenItem.tsx"][href^="/bsc/token/"]';
  const CALLOUT_SELECTOR = '[data-sentry-component="CalloutItem"]';
  const MANIFESTO_SELECTOR = '[data-sentry-component="ManifestoChipInner"]';
  const DEFAULTS = {
    enabled: true,
    showDevPerformance: true,
    showDevTooltip: true,
    enableDevBookmark: true,
    enableCalloutBlacklist: true,
    enableManifestoToast: true,
    enableManifestoTab: true,
    enableSpecialWallet: true,
    enableRemindAlert: true,
    enableFomoPanel: true,
    fomoPanelPos: null,
    fomoPanelOpen: false,
    enableHoldingSurge: true,
    holdingSurgeThreshold: 20,
    holdingWatchList: [],
    addWalletStarPref: { on: false, color: '#f5b83d', pin: false },
    hideLightningTrade: true,
    watchedDevs: [],
    blockedCallers: [],
    specialWallets: [],
    highlightColor: '#f5b83d',
  };

  let settings = { ...DEFAULTS };
  let watchedMap = new Map();
  let blockedWallets = new Set();
  let blockedHandles = new Set();
  // 特别关注高亮预设色（每个钱包可单独循环切换，首个为默认金色）。
  const SPECIAL_COLOR_PALETTE = [
    '#f5b83d',
    '#ef5350',
    '#43c07a',
    '#4c9ffe',
    '#b48ae0',
    '#ed6ba4',
    '#3ec6c6',
  ];
  let specialWalletMap = new Map();
  let scanScheduled = false;
  let scrollScanTimer = 0;
  let calloutToastTimer = 0;
  let blacklistModalOpen = false;
  let activeCard = null;
  let tooltip = null;

  // Dev 历史最高市值：gmgn.ai/api/v1/dev_created_tokens（同源，带会话，免配置）。
  const DEV_ATH_TTL_MS = 5 * 60 * 1000;
  const DEV_ATH_ERROR_RETRY_MS = 60 * 1000;
  const DEV_ATH_GAP_MS = 250;
  const DEV_ATH_QS =
    'device_id=&client_id=gmgn_web&from_app=gmgn&app_ver=&tz_name=Asia%2FShanghai&tz_offset=28800&app_lang=zh-CN&os=web';
  const devAthCache = new Map();
  const devAthQueue = [];
  const devAthQueued = new Set();
  let devAthTimer = 0;

  function getDevAth(creator) {
    if (!creator) return null;
    const hit = devAthCache.get(creator);
    const fresh = hit
      && Date.now() - hit.at < (hit.ok ? DEV_ATH_TTL_MS : DEV_ATH_ERROR_RETRY_MS);
    if (!fresh && !devAthQueued.has(creator)) {
      devAthQueued.add(creator);
      devAthQueue.push(creator);
      if (!devAthTimer) devAthTimer = window.setTimeout(processDevAthQueue, 50);
    }
    return hit && hit.ok && hit.mc > 0 ? hit : null;
  }

  async function processDevAthQueue() {
    devAthTimer = 0;
    if (settings.showDevPerformance === false) {
      devAthQueue.length = 0;
      devAthQueued.clear();
      return;
    }
    const creator = devAthQueue.shift();
    if (!creator) return;
    let entry = { at: Date.now(), ok: false, mc: 0, symbol: '' };
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `https://gmgn.ai/api/v1/dev_created_tokens/bsc/${creator}?${DEV_ATH_QS}`,
        { credentials: 'include', signal: controller.signal },
      );
      window.clearTimeout(timeout);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0) {
        const info = body.data?.creator_ath_info;
        entry = {
          at: Date.now(),
          ok: true,
          mc: Number(info?.ath_mc) || 0,
          symbol: String(info?.token_symbol || '').slice(0, 24),
        };
      }
    } catch {
      // 网络失败静默降级：峰段不显示，60s 后允许重试。
    }
    devAthCache.set(creator, entry);
    devAthQueued.delete(creator);
    if (entry.ok && entry.mc > 0) scheduleScan();
    if (devAthQueue.length) devAthTimer = window.setTimeout(processDevAthQueue, DEV_ATH_GAP_MS);
  }

  function formatAthMc(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    const fmt = (v) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)));
    if (n >= 1e9) return `$${fmt(n / 1e9)}B`;
    if (n >= 1e6) return `$${fmt(n / 1e6)}M`;
    if (n >= 1e3) return `$${fmt(n / 1e3)}K`;
    return `$${Math.round(n)}`;
  }

  function athTierClass(value) {
    const n = Number(value) || 0;
    if (n >= 1e7) return 'gdh-mc-t4';
    if (n >= 1e6) return 'gdh-mc-t3';
    if (n >= 1e5) return 'gdh-mc-t2';
    return 'gdh-mc-t1';
  }

  function normalizeAddress(value) {
    return typeof value === 'string' ? value.toLowerCase() : '';
  }

  function normalizeHandle(value) {
    return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  }

  function rebuildWatchedMap() {
    watchedMap = new Map(
      (Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [])
        .filter((item) => item && typeof item.address === 'string')
        .map((item) => [
          normalizeAddress(item.address),
          { address: normalizeAddress(item.address), label: String(item.label || '') },
        ]),
    );
  }

  function normalizeBlockedCaller(item) {
    if (!item || typeof item !== 'object') return null;
    const wallet = normalizeAddress(item.wallet);
    const handle = normalizeHandle(item.handle);
    if (!wallet && !handle) return null;
    return {
      wallet,
      handle,
      name: String(item.name || item.handle || item.wallet || '').trim(),
    };
  }

  function getBlockedCallers() {
    return (Array.isArray(settings.blockedCallers) ? settings.blockedCallers : [])
      .map(normalizeBlockedCaller)
      .filter(Boolean);
  }

  function rebuildBlockedCallerIndex() {
    const callers = getBlockedCallers();
    blockedWallets = new Set(callers.map((item) => item.wallet).filter(Boolean));
    blockedHandles = new Set(callers.map((item) => item.handle).filter(Boolean));
  }

  function normalizeSpecialColor(color) {
    if (color === 'rainbow') return 'rainbow';
    if (/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return String(color).toLowerCase();
    return SPECIAL_COLOR_PALETTE[0];
  }

  function rebuildSpecialWalletSet() {
    specialWalletMap = new Map(
      (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
        .map((item) => {
          const address = normalizeAddress(item?.address);
          if (!address) return null;
          return [address, {
            label: String(item?.label || ''),
            color: normalizeSpecialColor(item?.color),
            pin: item?.pin === true,
          }];
        })
        .filter(Boolean),
    );
  }

  function formatCount(value) {
    if (value == null || value === '') return '--';
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number).toLocaleString('zh-CN') : '--';
  }

  function getRatioPercent(card) {
    const migrated = card.dataset.gdhMigrated === undefined
      ? Number.NaN
      : Number(card.dataset.gdhMigrated);
    const total = card.dataset.gdhTotal === undefined
      ? Number.NaN
      : Number(card.dataset.gdhTotal);
    if (Number.isFinite(migrated) && Number.isFinite(total) && total > 0) {
      return (migrated / total) * 100;
    }

    const rawRatio = card.dataset.gdhRatio === undefined
      ? Number.NaN
      : Number(card.dataset.gdhRatio);
    if (!Number.isFinite(rawRatio)) return Number.NaN;
    return rawRatio <= 1 ? rawRatio * 100 : rawRatio;
  }

  function formatRatio(card) {
    const percent = getRatioPercent(card);
    if (!Number.isFinite(percent)) return '--';
    if (percent === 0) return '0%';
    if (percent < 0.1) return '<0.1%';
    if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
    return `${Math.round(percent)}%`;
  }

  function applyRateColor(performance, percent) {
    const rateKey = Number.isFinite(percent) ? percent.toFixed(6) : 'unknown';
    if (performance.dataset.gdhRateKey === rateKey) return;
    performance.dataset.gdhRateKey = rateKey;

    if (!Number.isFinite(percent)) {
      performance.style.setProperty('--gdh-rate-color', '#8b93a1');
      performance.style.setProperty('--gdh-rate-border', 'rgba(139, 147, 161, 0.38)');
      performance.style.setProperty('--gdh-rate-bg', 'rgba(139, 147, 161, 0.07)');
      performance.style.setProperty('--gdh-rate-glow', 'transparent');
      return;
    }

    const strength = Math.min(1, Math.log1p(Math.max(0, percent)) / Math.log1p(20));
    const saturation = Math.round(18 + (82 * strength));
    const lightness = Math.round(44 + (24 * strength));
    const borderAlpha = (0.34 + (0.56 * strength)).toFixed(2);
    const backgroundAlpha = (0.06 + (0.13 * strength)).toFixed(2);
    const glowAlpha = (0.28 * strength).toFixed(2);
    const color = `hsl(42 ${saturation}% ${lightness}%)`;

    performance.style.setProperty('--gdh-rate-color', color);
    performance.style.setProperty(
      '--gdh-rate-border',
      `hsl(42 ${saturation}% ${lightness}% / ${borderAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-bg',
      `hsl(42 ${saturation}% ${lightness}% / ${backgroundAlpha})`,
    );
    performance.style.setProperty(
      '--gdh-rate-glow',
      `hsl(42 ${saturation}% ${lightness}% / ${glowAlpha})`,
    );
  }

  function clearWatchState(card) {
    delete card.dataset.gdhWatched;
    delete card.dataset.gdhHighlighted;
    delete card.dataset.gdhBadge;
    delete card.dataset.gdhWatchLabel;
    if (card === activeCard) {
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    }
  }

  function applyDevPerformance(card) {
    const details = card.children[1]?.firstElementChild;
    const metricsRow = details
      ? [...details.children].find((element) => {
        const className = String(element.className);
        return className.includes('h-[24px]')
          && className.includes('font-medium')
          && className.includes('overflow-hidden');
      })
      : null;

    let performance = card.querySelector('.gdh-dev-performance');
    if (settings.showDevPerformance === false || !metricsRow || card.dataset.gdhReady !== '1') {
      performance?.remove();
      return;
    }

    if (!performance) {
      performance = document.createElement('span');
      performance.className = 'gdh-dev-performance';
      metricsRow.prepend(performance);
    }

    const migrated = formatCount(card.dataset.gdhMigrated);
    const total = formatCount(card.dataset.gdhTotal);
    const ratio = formatRatio(card);
    applyRateColor(performance, getRatioPercent(card));

    const ath = getDevAth(normalizeAddress(card.dataset.gdhCreator));
    const rateText = `迁${migrated}发${total}·${ratio}`;
    const mcText = ath ? `峰${formatAthMc(ath.mc)}` : '';
    const tier = ath ? athTierClass(ath.mc) : '';
    const signature = `${rateText}|${mcText}|${tier}`;
    if (performance.dataset.gdhSig !== signature) {
      performance.dataset.gdhSig = signature;
      performance.textContent = '';
      const rateEl = document.createElement('span');
      rateEl.textContent = rateText;
      performance.appendChild(rateEl);
      if (mcText) {
        const sep = document.createElement('span');
        sep.className = 'gdh-dev-performance__sep';
        sep.textContent = '·';
        const mcEl = document.createElement('span');
        mcEl.className = `gdh-dev-performance__mc ${tier}`;
        mcEl.textContent = mcText;
        performance.append(sep, mcEl);
      }
    }
    performance.title = `Dev 发币迁移数：${migrated}\nDev 发币总数：${total}\nDev 发币迁移比例：${ratio}${
      ath ? `\nDev 最高市值币：${ath.symbol || '未知'} ${formatAthMc(ath.mc)}` : ''
    }`;
  }

  function getDeveloperPanelContexts() {
    return [...document.querySelectorAll('div')]
      .filter((element) => (
        element.children.length === 0
        && element.textContent?.trim() === '代币统计'
        && element.getClientRects().length > 0
      ))
      .map((heading) => {
        const container = heading.parentElement;
        const creatorLink = [...container.querySelectorAll('a[href^="/bsc/address/"]')]
          .find((link) => /^\/bsc\/address\/0x[a-fA-F0-9]{40}$/.test(link.getAttribute('href') || ''));
        const match = creatorLink?.getAttribute('href')?.match(/\/bsc\/address\/(0x[a-fA-F0-9]{40})$/);
        const symbolElement = document.querySelector('#token-base-symbol[data-symbol]');
        const symbol = String(symbolElement?.dataset.symbol || symbolElement?.textContent || '').trim();
        if (!container || !match || !symbol) return null;
        return {
          container,
          creator: match[1].toLowerCase(),
          label: `${symbol}dev`,
          insertAfter: container.querySelector('[data-sentry-component="DevFundsSource"]'),
        };
      })
      .filter(Boolean);
  }

  function updateDeveloperButton(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const saved = watchedMap.get(address);
    const nextText = saved
      ? `✓ 已收藏 · ${saved.label || address}`
      : '☆ 一键收藏 Dev';
    button.classList.toggle('is-saved', Boolean(saved));
    if (button.textContent !== nextText) button.textContent = nextText;
    button.title = saved
      ? `已收藏 ${address}`
      : `收藏 GMGN Dev ${address}`;
  }

  function saveDeveloper(button) {
    const address = normalizeAddress(button.dataset.gdhDevAddress);
    const label = String(button.dataset.gdhDevLabel || '').trim();
    if (!address || !label) return;

    const current = Array.isArray(settings.watchedDevs) ? settings.watchedDevs : [];
    const next = [
      ...current.filter((item) => normalizeAddress(item?.address) !== address),
      { address, label },
    ];

    button.disabled = true;
    button.textContent = '正在收藏…';
    chrome.storage.local.set({ watchedDevs: next }, () => {
      button.disabled = false;
      const error = chrome.runtime?.lastError;
      if (error) {
        button.textContent = '收藏失败，请重试';
        button.title = error.message;
        return;
      }
      settings.watchedDevs = next;
      rebuildWatchedMap();
      updateDeveloperButton(button);
      scheduleScan();
    });
  }

  function ensureDeveloperBookmarkButtons() {
    if (settings.enableDevBookmark === false) {
      document.querySelectorAll('.gdh-dev-save-button').forEach((button) => button.remove());
      return;
    }

    for (const context of getDeveloperPanelContexts()) {
      let button = context.container.querySelector(':scope > .gdh-dev-save-button');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'gdh-dev-save-button';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          saveDeveloper(button);
        });
        if (context.insertAfter) context.insertAfter.insertAdjacentElement('afterend', button);
        else context.container.appendChild(button);
      }
      button.dataset.gdhDevAddress = context.creator;
      button.dataset.gdhDevLabel = context.label;
      updateDeveloperButton(button);
    }
  }

  function applyCardState(card) {
    if (!card.closest('[data-sentry-component="PumpSubX"]')) return;

    applyDevPerformance(card);

    const creator = normalizeAddress(card.dataset.gdhCreator);
    const watched = watchedMap.get(creator);
    const highlightEnabled = settings.enabled !== false;
    const tooltipEnabled = settings.showDevTooltip !== false;
    if (!watched || (!highlightEnabled && !tooltipEnabled)) {
      clearWatchState(card);
      return;
    }

    card.dataset.gdhWatched = '1';
    card.dataset.gdhWatchLabel = watched.label;
    if (highlightEnabled) {
      card.dataset.gdhHighlighted = '1';
      card.dataset.gdhBadge = watched.label ? `★ ${watched.label}` : '★ 重点 DEV';
    } else {
      delete card.dataset.gdhHighlighted;
      delete card.dataset.gdhBadge;
    }
  }

  function getCallerFromElement(element) {
    return normalizeBlockedCaller({
      wallet: element.dataset.gdhCallerWallet,
      handle: element.dataset.gdhCallerHandle,
      name: element.dataset.gdhCallerName,
    });
  }

  function callersMatch(left, right) {
    return Boolean(
      (left.wallet && right.wallet && left.wallet === right.wallet)
      || (left.handle && right.handle && left.handle === right.handle),
    );
  }

  function isCallerBlocked(caller) {
    return Boolean(
      settings.enableCalloutBlacklist !== false
      &&
      caller
      && ((caller.wallet && blockedWallets.has(caller.wallet))
        || (caller.handle && blockedHandles.has(caller.handle))),
    );
  }

  function findCalloutHeading(scope) {
    return [...scope.querySelectorAll('span')].find((element) => (
      element.children.length === 0 && element.textContent?.trim() === '喊单'
    ));
  }

  function getCalloutPanelContext() {
    // 2026-08-07 之前的构建：面板根节点带 GlobalCalloutPanel 标记。
    const panel = document.querySelector('[data-sentry-component="GlobalCalloutPanel"]');
    if (panel) {
      const heading = findCalloutHeading(panel);
      const header = heading?.parentElement?.parentElement;
      const controls = header?.children[1];
      if (!heading || !header || !controls) return null;
      return { panel, header, controls };
    }

    // 2026-08-08 GMGN 改版去掉了 GlobalCalloutPanel：改从喊单面板的
    // tab 按钮（我的 / GMGN全部）定位，再用同面板内的“喊单”标题确认。
    for (const tab of document.querySelectorAll('button[data-sentry-component="renderTab"]')) {
      const tabsRow = tab.parentElement?.parentElement;
      const headerBlock = tabsRow?.parentElement;
      const header = headerBlock?.children[0];
      const root = headerBlock?.parentElement;
      if (!header || !root || header === tabsRow) continue;
      const heading = findCalloutHeading(header);
      const controls = heading ? header.children[1] : null;
      if (!heading || !controls) continue;
      return { panel: root, header, controls };
    }
    return null;
  }

  function showCalloutToast(text) {
    const context = getCalloutPanelContext();
    if (!context) return;
    let toast = context.panel.querySelector(':scope > .gdh-callout-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'gdh-callout-toast';
      context.panel.appendChild(toast);
    }
    toast.textContent = text;
    window.clearTimeout(calloutToastTimer);
    calloutToastTimer = window.setTimeout(() => toast.remove(), 1800);
  }

  function persistBlockedCallers(next, successMessage) {
    const previous = getBlockedCallers();
    settings.blockedCallers = next;
    rebuildBlockedCallerIndex();
    scanCalloutBlacklist();

    chrome.storage.local.set({ blockedCallers: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.blockedCallers = previous;
        rebuildBlockedCallerIndex();
        scanCalloutBlacklist();
        showCalloutToast('黑名单保存失败');
        return;
      }
      showCalloutToast(successMessage);
    });
  }

  function blockCaller(caller) {
    if (!caller) return;
    const next = [
      ...getBlockedCallers().filter((item) => !callersMatch(item, caller)),
      caller,
    ];
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `已屏蔽 ${label}`);
  }

  function unblockCaller(caller) {
    const next = getBlockedCallers().filter((item) => !callersMatch(item, caller));
    const label = caller.handle ? `@${caller.handle}` : caller.name || caller.wallet;
    persistBlockedCallers(next, `已解除 ${label}`);
  }

  function renderBlacklistModal(modal) {
    const callers = getBlockedCallers();
    const key = JSON.stringify(callers);
    if (modal.dataset.gdhBlacklistKey === key) return;
    modal.dataset.gdhBlacklistKey = key;

    const list = modal.querySelector('.gdh-callout-blacklist-list');
    list.replaceChildren();
    if (!callers.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-callout-blacklist-empty';
      empty.textContent = '暂未屏蔽任何喊单人';
      list.appendChild(empty);
      return;
    }

    for (const caller of callers) {
      const item = document.createElement('div');
      item.className = 'gdh-callout-blacklist-item';

      const identity = document.createElement('div');
      identity.className = 'gdh-callout-blacklist-identity';
      const name = document.createElement('strong');
      name.textContent = caller.name || (caller.handle ? `@${caller.handle}` : caller.wallet);
      const details = document.createElement('span');
      const wallet = caller.wallet
        ? `${caller.wallet.slice(0, 8)}…${caller.wallet.slice(-6)}`
        : '';
      details.textContent = [caller.handle ? `@${caller.handle}` : '', wallet]
        .filter(Boolean)
        .join(' · ');
      identity.append(name, details);

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'gdh-callout-unblock-button';
      removeButton.textContent = '解除';
      removeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        unblockCaller(caller);
      });

      item.append(identity, removeButton);
      list.appendChild(item);
    }
  }

  function ensureBlacklistModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-callout-blacklist-modal');
    if (!blacklistModalOpen) {
      modal?.remove();
      return;
    }

    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-callout-blacklist-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-callout-blacklist-header';
      const title = document.createElement('strong');
      title.textContent = '喊单黑名单';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-callout-blacklist-close';
      close.textContent = '×';
      close.title = '关闭黑名单';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = false;
        modal.remove();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-callout-blacklist-list';
      modal.append(header, list);
      panel.appendChild(modal);
    }
    renderBlacklistModal(modal);
  }

  function ensureCalloutControls() {
    const context = getCalloutPanelContext();
    if (!context) return;
    context.panel.classList.add('gdh-callout-panel-host');

    let button = context.controls.querySelector(':scope > .gdh-callout-blacklist-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-blacklist-button';
      button.title = '管理喊单黑名单';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blacklistModalOpen = !blacklistModalOpen;
        if (blacklistModalOpen) maniListOpen = false;
        scheduleScan();
      });
      context.controls.prepend(button);
    }

    const count = getBlockedCallers().length;
    const text = count ? `黑名单 ${count}` : '黑名单';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', blacklistModalOpen);
    ensureBlacklistModal(context.panel);
  }

  function ensureCalloutBlockButton(card) {
    const addressView = card.querySelector('[data-sentry-component="WalletAddressView"]');
    const addressLink = addressView?.closest('a[href*="/address/0x"]');
    const titleRow = addressLink?.parentElement;
    if (!titleRow) return;

    let button = titleRow.querySelector(':scope > .gdh-callout-block-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-callout-block-button';
      button.textContent = '屏蔽';
      button.title = '一键屏蔽此喊单人';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        blockCaller(getCallerFromElement(card));
      });
      titleRow.appendChild(button);
    }
  }

  function applyCalloutCardState(card) {
    const host = card.closest('.gmgn-vlist-item') || card;
    if (host.dataset.gdhCalloutHost !== '1') host.dataset.gdhCalloutHost = '1';
    const caller = getCallerFromElement(card);
    const blocked = isCallerBlocked(caller);
    if (blocked) host.dataset.gdhCallerBlocked = '1';
    else delete host.dataset.gdhCallerBlocked;
    if (caller) ensureCalloutBlockButton(card);
  }

  function applyManifestoState(chip) {
    const blocked = isCallerBlocked(getCallerFromElement(chip));
    if (blocked) chip.dataset.gdhCallerBlocked = '1';
    else delete chip.dataset.gdhCallerBlocked;
  }

  // ---- 钱包追踪"特别关注"高亮 ----
  const TRACKER_ITEM_SELECTOR = '[data-sentry-component="TrackerListItem"]';
  const WALLET_TABLE_SELECTOR = '[data-sentry-component="WalletTable"]';

  function extractRowWalletAddress(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    const match = link?.getAttribute('href')?.match(/\/address\/(0x[a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : '';
  }

  function extractRowWalletLabel(scope) {
    const link = scope.querySelector('a[href*="/address/0x"]');
    return String(link?.textContent || '').trim().slice(0, 32);
  }

  function isSpecialWallet(address) {
    return Boolean(address && specialWalletMap.has(address));
  }

  function specialWalletColor(address) {
    return specialWalletMap.get(address)?.color || SPECIAL_COLOR_PALETTE[0];
  }

  function hexToRgba(hex, alpha) {
    const m = String(hex).match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return `rgba(245, 184, 61, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function persistSpecialWallets(next) {
    const previous = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    settings.specialWallets = next;
    rebuildSpecialWalletSet();
    scanSpecialWallets();
    chrome.storage.local.set({ specialWallets: next }, () => {
      const error = chrome.runtime?.lastError;
      if (error) {
        settings.specialWallets = previous;
        rebuildSpecialWalletSet();
        scanSpecialWallets();
      }
    });
  }

  function toggleSpecialWallet(address, label) {
    if (!address) return;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    const exists = current.some((item) => normalizeAddress(item?.address) === address);
    const next = exists
      ? current.filter((item) => normalizeAddress(item?.address) !== address)
      : [...current, { address, label: label || '', color: SPECIAL_COLOR_PALETTE[0] }];
    persistSpecialWallets(next);
  }

  function setSpecialWalletColor(address, color) {
    if (!address || !specialWalletMap.has(address)) return;
    if (color !== 'rainbow' && !/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeAddress(item?.address) === address
          ? { ...item, color: normalizeSpecialColor(color) }
          : item
      ));
    persistSpecialWallets(next);
  }

  function setSpecialWalletPin(address, pin) {
    if (!address || !specialWalletMap.has(address)) return;
    const next = (Array.isArray(settings.specialWallets) ? settings.specialWallets : [])
      .map((item) => (
        normalizeAddress(item?.address) === address ? { ...item, pin: pin === true } : item
      ));
    persistSpecialWallets(next);
  }

  function addSpecialWallet(address, label, color, pin) {
    const normalized = normalizeAddress(address);
    if (!/^0x[a-f0-9]{40}$/.test(normalized) || specialWalletMap.has(normalized)) return false;
    const current = Array.isArray(settings.specialWallets) ? settings.specialWallets : [];
    persistSpecialWallets([
      ...current,
      {
        address: normalized,
        label: String(label || '').trim().slice(0, 32),
        color: normalizeSpecialColor(color),
        pin: pin === true,
      },
    ]);
    return true;
  }

  // ---- 预设色选择浮层（点色块展开全部颜色，点选即换）----
  let colorPaletteEl = null;

  function closeColorPalette() {
    colorPaletteEl?.remove();
    colorPaletteEl = null;
  }

  function openColorPalette(address, anchorRect) {
    closeColorPalette();
    const palette = document.createElement('div');
    palette.className = 'gdh-color-palette';
    palette.addEventListener('pointerdown', (event) => event.stopPropagation());
    const current = specialWalletColor(address);

    const colorsRow = document.createElement('div');
    colorsRow.className = 'gdh-color-palette__row';
    for (const color of SPECIAL_COLOR_PALETTE) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-color-palette__dot';
      dot.style.background = color;
      dot.classList.toggle('is-current', color === current);
      dot.title = color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletColor(address, color);
        closeColorPalette();
      });
      colorsRow.appendChild(dot);
    }
    // 炫彩
    const rainbow = document.createElement('button');
    rainbow.type = 'button';
    rainbow.className = 'gdh-color-palette__dot gdh-color-palette__dot--rainbow';
    rainbow.classList.toggle('is-current', current === 'rainbow');
    rainbow.title = '炫彩高亮';
    rainbow.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSpecialWalletColor(address, 'rainbow');
      closeColorPalette();
    });
    colorsRow.appendChild(rainbow);
    // 自定义取色
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-color-palette__custom';
    custom.value = current === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : current;
    custom.title = '自定义颜色';
    custom.addEventListener('change', () => {
      setSpecialWalletColor(address, custom.value);
      closeColorPalette();
    });
    colorsRow.appendChild(custom);
    palette.appendChild(colorsRow);

    // 置顶推送开关
    const pinRow = document.createElement('label');
    pinRow.className = 'gdh-color-palette__pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = specialWalletMap.get(address)?.pin === true;
    pinBox.addEventListener('change', () => {
      setSpecialWalletPin(address, pinBox.checked);
    });
    const pinText = document.createElement('span');
    pinText.textContent = '📌 新推送置顶 10 秒';
    pinRow.append(pinBox, pinText);
    palette.appendChild(pinRow);

    document.body.appendChild(palette);
    const width = palette.offsetWidth || 220;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - width / 2));
    let top = anchorRect.bottom + 6;
    const height = palette.offsetHeight || 60;
    if (top + height + 8 > window.innerHeight) top = anchorRect.top - height - 6;
    palette.style.left = `${Math.round(left)}px`;
    palette.style.top = `${Math.round(top)}px`;
    colorPaletteEl = palette;
  }

  document.addEventListener('pointerdown', (event) => {
    if (!colorPaletteEl) return;
    if (event.target instanceof Node && colorPaletteEl.contains(event.target)) return;
    closeColorPalette();
  }, true);
  document.addEventListener('scroll', () => closeColorPalette(), true);

  /** 追踪卡里"建仓/加仓/减仓/清仓"文案所在的 flex 容器（0.12.1 起 ⭐ 挂这里）。 */
  function findCardActionContainer(card) {
    const span = [...card.querySelectorAll('span')].find((el) => (
      el.children.length <= 1
      && /^(建仓|加仓|减仓|清仓)/.test((el.textContent || '').trim())
    ));
    return span?.parentElement instanceof HTMLElement ? span.parentElement : null;
  }

  function ensureStarButton(host, address, label, anchor, insertMode) {
    let button = host.querySelector('.gdh-star-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-star-button';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(
          button.dataset.gdhStarAddr || '',
          button.dataset.gdhStarLabel || '',
        );
      });
      if (anchor instanceof HTMLElement && insertMode === 'after') {
        // 钱包列表行：贴在名字链接后面（占位恒定，悬停才显形）。
        button.classList.add('gdh-star-button--inline');
        anchor.insertAdjacentElement('afterend', button);
      } else if (anchor instanceof HTMLElement && insertMode === 'append') {
        // 追踪事件卡：跟在 加仓/减仓 等动作文案末尾。
        button.classList.add('gdh-star-button--inline');
        anchor.appendChild(button);
      } else {
        // 兜底：绝对定位在卡片右侧（找不到动作容器时）。
        host.appendChild(button);
      }
    }
    button.dataset.gdhStarAddr = address;
    button.dataset.gdhStarLabel = label;
    const starred = isSpecialWallet(address);
    const starColor = starred ? specialWalletColor(address) : '';
    const text = starred ? '★' : '☆';
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-starred', starred);
    button.classList.toggle('gdh-rainbow-text', starColor === 'rainbow');
    button.style.color = starred && starColor !== 'rainbow' ? starColor : '';
    button.title = starred ? '取消特别关注' : '特别关注';

    // 已关注且按钮是行内挂载时，旁边给一个当前色小色块，点开预设色浮层选色。
    let swatch = host.querySelector('.gdh-color-button');
    if (starred && button.classList.contains('gdh-star-button--inline')) {
      if (!swatch) {
        swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'gdh-color-button';
        swatch.addEventListener('pointerdown', (event) => event.stopPropagation());
        swatch.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openColorPalette(
            swatch.dataset.gdhStarAddr || '',
            swatch.getBoundingClientRect(),
          );
        });
        button.insertAdjacentElement('afterend', swatch);
      }
      swatch.dataset.gdhStarAddr = address;
      applySwatchColor(swatch, specialWalletColor(address));
      swatch.title = '选择高亮颜色 / 置顶';
    } else {
      swatch?.remove();
    }
    return button;
  }

  function applySwatchColor(el, color) {
    if (color === 'rainbow') {
      el.style.background = 'conic-gradient(#ef5350, #f5b83d, #43c07a, #4c9ffe, #b48ae0, #ed6ba4, #ef5350)';
    } else {
      el.style.background = color;
    }
  }

  function applySpecialState(host, address) {
    if (isSpecialWallet(address)) {
      const color = specialWalletColor(address);
      host.dataset.gdhSpecial = '1';
      if (color === 'rainbow') {
        host.dataset.gdhSpRainbow = '1';
        host.style.removeProperty('--gdh-sp-bg');
        host.style.removeProperty('--gdh-sp-border');
      } else {
        delete host.dataset.gdhSpRainbow;
        host.style.setProperty('--gdh-sp-bg', hexToRgba(color, 0.1));
        host.style.setProperty('--gdh-sp-border', color);
      }
    } else {
      delete host.dataset.gdhSpecial;
      delete host.dataset.gdhSpRainbow;
      host.style.removeProperty('--gdh-sp-bg');
      host.style.removeProperty('--gdh-sp-border');
    }
  }

  function findWalletTableRow(link) {
    let row = link;
    for (let depth = 0; depth < 8 && row.parentElement; depth += 1) {
      row = row.parentElement;
      if (row.matches?.(WALLET_TABLE_SELECTOR)) return null;
      const cls = String(row.className || '');
      if (cls.includes('h-[44px]') || cls.includes('h-[64')) return row;
      const rect = row.getBoundingClientRect();
      if (rect.width > 200 && rect.height >= 36 && rect.height <= 130) return row;
    }
    return null;
  }

  function scanSpecialWallets() {
    if (settings.enableSpecialWallet === false) {
      closeColorPalette();
      specialManageOpen = false;
      document
        .querySelectorAll('.gdh-star-button, .gdh-color-button, .gdh-sp-manage-button, .gdh-sp-manage-modal, .gdh-pin-strip, .gdh-addw-row')
        .forEach((node) => node.remove());
      document.querySelectorAll('[data-gdh-special="1"]').forEach((node) => {
        delete node.dataset.gdhSpecial;
        delete node.dataset.gdhSpRainbow;
        node.style.removeProperty('--gdh-sp-bg');
        node.style.removeProperty('--gdh-sp-border');
      });
      document.querySelectorAll('[data-gdh-star-host="1"]').forEach((node) => {
        delete node.dataset.gdhStarHost;
      });
      return;
    }

    // 追踪事件卡：卡片即 <a>，钱包地址取内部 /address/ 链接。
    document.querySelectorAll(TRACKER_ITEM_SELECTOR).forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      if (card.dataset.gdhStarHost !== '1') card.dataset.gdhStarHost = '1';
      applySpecialState(card, address);
      ensureStarButton(
        card,
        address,
        extractRowWalletLabel(card),
        findCardActionContainer(card),
        'append',
      );
    });

    // 钱包列表行：从地址链接爬到行容器。
    document.querySelectorAll(WALLET_TABLE_SELECTOR).forEach((table) => {
      table.querySelectorAll('a[href*="/address/0x"]').forEach((link) => {
        const row = findWalletTableRow(link);
        if (!(row instanceof HTMLElement)) return;
        const address = extractRowWalletAddress(row);
        if (!address) return;
        if (row.dataset.gdhStarHost !== '1') row.dataset.gdhStarHost = '1';
        applySpecialState(row, address);
        ensureStarButton(row, address, extractRowWalletLabel(row), link, 'after');
      });
    });

    ensureAddressPageStar();
    ensureAddWalletStarRow();
    ensureSpecialManageUI();
    scanPinnedPush();
  }

  // ---- 地址页（添加/关注钱包处）同步打星 ----
  function ensureAddressPageStar() {
    const match = location.href.match(/address\/(0x[a-fA-F0-9]{40})/);
    const follow = document.querySelector('[data-sentry-component="UserFollow"]');
    const existing = document.querySelector('.gdh-star-button--address');
    if (!match || !(follow instanceof HTMLElement) || !follow.parentElement) {
      existing?.remove();
      document.querySelector('.gdh-color-button--address')?.remove();
      return;
    }
    const address = match[1].toLowerCase();
    const host = follow.parentElement;
    if (host.dataset.gdhStarHost !== '1') host.dataset.gdhStarHost = '1';
    const label = String(document.title || '').split(' ')[0].trim().slice(0, 32);
    const button = ensureStarButton(host, address, label, follow, 'after');
    if (button) {
      button.classList.add('gdh-star-button--address');
      const swatch = host.querySelector('.gdh-color-button');
      swatch?.classList.add('gdh-color-button--address');
    }
  }

  // ---- GMGN「添加钱包」弹窗内联特别关注设置 ----
  // 用 placeholder / 按钮文案定位，不依赖 GMGN 的类名与组件标记（改版更抗造）。
  const ADDR_PLACEHOLDER_RE = /钱包地址|wallet\s*address/i;
  const NAME_PLACEHOLDER_RE = /钱包名称|wallet\s*name|备注/i;
  const ADD_SUBMIT_RE = /^(添加钱包|add\s*wallet)$/i;

  function findAddWalletDialog() {
    const addrInput = [...document.querySelectorAll('input')].find((el) => (
      ADDR_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
      && el.getClientRects().length > 0
    ));
    if (!addrInput) return null;
    let node = addrInput.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const submit = [...node.querySelectorAll('button, div[role="button"]')].find((el) => (
        ADD_SUBMIT_RE.test((el.textContent || '').trim())
      ));
      if (submit) {
        const nameInput = [...node.querySelectorAll('input')].find((el) => (
          el !== addrInput && NAME_PLACEHOLDER_RE.test(el.getAttribute('placeholder') || '')
        ));
        return { dialog: node, addrInput, nameInput: nameInput || null, submit };
      }
      node = node.parentElement;
    }
    return null;
  }

  function readAddWalletPref() {
    const p = settings.addWalletStarPref;
    return {
      on: p?.on === true,
      color: normalizeSpecialColor(p?.color),
      pin: p?.pin === true,
    };
  }

  function saveAddWalletPref(pref) {
    settings.addWalletStarPref = pref;
    try {
      chrome.storage.local.set({ addWalletStarPref: pref });
    } catch {
      // context invalidated
    }
  }

  function ensureAddWalletStarRow() {
    const ctx = findAddWalletDialog();
    if (!ctx) return;
    if (settings.enableSpecialWallet === false) {
      ctx.dialog.querySelector(':scope .gdh-addw-row')?.remove();
      return;
    }
    let row = ctx.dialog.querySelector(':scope .gdh-addw-row');
    if (row) return;

    const pref = readAddWalletPref();
    row = document.createElement('div');
    row.className = 'gdh-addw-row';
    row.addEventListener('pointerdown', (event) => event.stopPropagation());

    const toggle = document.createElement('label');
    toggle.className = 'gdh-addw-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = pref.on;
    const star = document.createElement('span');
    star.className = 'gdh-addw-star';
    star.textContent = '★';
    const text = document.createElement('span');
    text.textContent = '同时特别关注';
    toggle.append(box, star, text);
    row.appendChild(toggle);

    const opts = document.createElement('div');
    opts.className = 'gdh-addw-opts';
    const dots = document.createElement('div');
    dots.className = 'gdh-addw-dots';
    let chosen = pref.color;
    const renderDots = () => {
      [...dots.querySelectorAll('.gdh-addw-dot')].forEach((d) => {
        d.classList.toggle('is-current', d.dataset.color === chosen);
      });
      star.style.color = chosen === 'rainbow' ? '' : chosen;
      star.classList.toggle('gdh-rainbow-text', chosen === 'rainbow');
    };
    [...SPECIAL_COLOR_PALETTE, 'rainbow'].forEach((color) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'gdh-addw-dot';
      dot.dataset.color = color;
      applySwatchColor(dot, color);
      dot.title = color === 'rainbow' ? '炫彩' : color;
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chosen = color;
        renderDots();
      });
      dots.appendChild(dot);
    });
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'gdh-addw-custom';
    custom.value = chosen === 'rainbow' ? SPECIAL_COLOR_PALETTE[0] : chosen;
    custom.title = '自定义颜色';
    custom.addEventListener('input', () => {
      chosen = custom.value;
      renderDots();
    });
    dots.appendChild(custom);
    opts.appendChild(dots);

    const pinLabel = document.createElement('label');
    pinLabel.className = 'gdh-addw-pin';
    const pinBox = document.createElement('input');
    pinBox.type = 'checkbox';
    pinBox.checked = pref.pin;
    const pinText = document.createElement('span');
    pinText.textContent = '📌 推送置顶';
    pinLabel.append(pinBox, pinText);
    opts.appendChild(pinLabel);
    row.appendChild(opts);

    const syncEnabled = () => {
      row.classList.toggle('is-on', box.checked);
      opts.querySelectorAll('button, input').forEach((el) => { el.disabled = !box.checked; });
    };
    box.addEventListener('change', syncEnabled);
    syncEnabled();
    renderDots();

    // 提交时把地址+备注登记为特别关注（捕获阶段先于 GMGN 关闭弹窗）。
    ctx.submit.addEventListener('click', () => {
      if (!box.checked) {
        saveAddWalletPref({ on: false, color: chosen, pin: pinBox.checked });
        return;
      }
      const address = String(ctx.addrInput.value || '').trim();
      const label = String(ctx.nameInput?.value || '').trim();
      saveAddWalletPref({ on: true, color: chosen, pin: pinBox.checked });
      if (!addSpecialWallet(address, label, chosen, pinBox.checked)) {
        // 已在名单里就只更新颜色/置顶
        const normalized = normalizeAddress(address);
        if (specialWalletMap.has(normalized)) {
          setSpecialWalletColor(normalized, chosen);
          setSpecialWalletPin(normalized, pinBox.checked);
        }
      }
    }, true);

    ctx.submit.parentElement?.insertBefore(row, ctx.submit);
  }

  // ---- 特别关注管理面板（钱包追踪面板头部入口）----
  let specialManageOpen = false;

  function specialEntries() {
    return [...specialWalletMap.entries()].map(([address, meta]) => ({ address, ...meta }));
  }

  function ensureSpecialManageUI() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    const header = panel?.querySelector('[data-sentry-component="TrackingHeader"]');
    if (!(header instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      if (specialManageOpen) specialManageOpen = false;
      document.querySelector('.gdh-sp-manage-modal')?.remove();
      return;
    }
    let button = header.querySelector(':scope .gdh-sp-manage-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-sp-manage-button';
      button.title = '特别关注管理';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = !specialManageOpen;
        scheduleScan();
      });
      header.appendChild(button);
    }
    const text = `★${specialWalletMap.size}`;
    if (button.textContent !== text) button.textContent = text;
    button.classList.toggle('is-active', specialManageOpen);
    ensureSpecialManageModal(panel);
  }

  function ensureSpecialManageModal(panel) {
    let modal = panel.querySelector(':scope > .gdh-sp-manage-modal');
    if (!specialManageOpen) {
      modal?.remove();
      return;
    }
    panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-sp-manage-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const head = document.createElement('div');
      head.className = 'gdh-sp-manage__head';
      const title = document.createElement('strong');
      title.className = 'gdh-sp-manage__title';
      title.textContent = '特别关注管理';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-sp-manage__close';
      close.textContent = '×';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        specialManageOpen = false;
        modal.remove();
        scheduleScan();
      });
      head.append(title, close);

      const addRow = document.createElement('div');
      addRow.className = 'gdh-sp-manage__add';
      const addrInput = document.createElement('input');
      addrInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--addr';
      addrInput.placeholder = '0x 钱包地址';
      addrInput.spellcheck = false;
      const labelInput = document.createElement('input');
      labelInput.className = 'gdh-sp-manage__input gdh-sp-manage__input--label';
      labelInput.placeholder = '备注(可选)';
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'gdh-sp-manage__addbtn';
      addButton.textContent = '添加';
      addButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (addSpecialWallet(addrInput.value, labelInput.value)) {
          addrInput.value = '';
          labelInput.value = '';
        } else {
          addrInput.classList.add('is-error');
          window.setTimeout(() => addrInput.classList.remove('is-error'), 900);
        }
      });
      addRow.append(addrInput, labelInput, addButton);

      const list = document.createElement('div');
      list.className = 'gdh-sp-manage__list';
      modal.append(head, addRow, list);
      panel.appendChild(modal);
    }

    // 挂在面板头部下方
    try {
      const headerRect = panel
        .querySelector('[data-sentry-component="TrackingHeader"]')
        .getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      modal.style.top = `${Math.max(30, Math.round(headerRect.bottom - panelRect.top) + 4)}px`;
    } catch {
      modal.style.top = '34px';
    }
    renderSpecialManageList(modal);
  }

  function renderSpecialManageList(modal) {
    const entries = specialEntries();
    const key = JSON.stringify(entries);
    if (modal.dataset.gdhSpKey === key) return;
    modal.dataset.gdhSpKey = key;
    const title = modal.querySelector('.gdh-sp-manage__title');
    if (title) title.textContent = `特别关注管理 · ${entries.length}`;
    const list = modal.querySelector('.gdh-sp-manage__list');
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-sp-manage__empty';
      empty.textContent = '还没有特别关注的钱包';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'gdh-sp-manage__row';

      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'gdh-sp-manage__swatch';
      applySwatchColor(swatch, entry.color);
      swatch.title = '选择高亮颜色 / 置顶';
      swatch.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openColorPalette(entry.address, swatch.getBoundingClientRect());
      });

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'gdh-sp-manage__pin';
      pin.textContent = '📌';
      pin.classList.toggle('is-on', entry.pin);
      pin.title = entry.pin ? '已置顶：新推送置顶 10 秒' : '未置顶';
      pin.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setSpecialWalletPin(entry.address, !entry.pin);
      });

      const name = document.createElement('span');
      name.className = 'gdh-sp-manage__name';
      name.textContent = entry.label || '(无备注)';
      const addr = document.createElement('span');
      addr.className = 'gdh-sp-manage__addr';
      addr.textContent = `${entry.address.slice(0, 6)}…${entry.address.slice(-4)}`;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'gdh-sp-manage__remove';
      remove.textContent = '移除';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSpecialWallet(entry.address, entry.label);
      });

      row.append(swatch, pin, name, addr, remove);
      list.appendChild(row);
    }
  }

  // ---- 置顶推送：特别关注(置顶)钱包的新事件卡置顶显示 10 秒 ----
  const SPECIAL_PIN_MS = 10000;
  const SPECIAL_PIN_MAX = 3;
  const SPECIAL_PIN_SEEN_MAX = 400;
  const specialPinSeen = new Set();
  let specialPinBaselineDone = false;
  let specialPinStrip = null;

  function hasPinnedWallets() {
    for (const meta of specialWalletMap.values()) if (meta.pin) return true;
    return false;
  }

  function trackerCardSignature(card, address) {
    const action = findCardActionContainer(card);
    const actionText = action
      ? [...action.children].filter((el) => el.tagName === 'SPAN').map((el) => (el.textContent || '').trim()).join('')
      : '';
    const amount = (card.querySelector('[data-sentry-component="LiteTrackerAmount"]')?.textContent || '').trim();
    return `${address}|${card.getAttribute('href') || ''}|${actionText}|${amount}`;
  }

  function rememberPinSeen(sig) {
    specialPinSeen.add(sig);
    if (specialPinSeen.size > SPECIAL_PIN_SEEN_MAX) {
      const iterator = specialPinSeen.values();
      for (let extra = specialPinSeen.size - SPECIAL_PIN_SEEN_MAX; extra > 0; extra -= 1) {
        specialPinSeen.delete(iterator.next().value);
      }
    }
  }

  function ensurePinStrip(panel) {
    if (specialPinStrip && specialPinStrip.isConnected) return specialPinStrip;
    specialPinStrip = document.createElement('div');
    specialPinStrip.className = 'gdh-pin-strip';
    panel.classList.add('gdh-callout-panel-host');
    panel.appendChild(specialPinStrip);
    return specialPinStrip;
  }

  function pinTrackerCard(card, panel) {
    const strip = ensurePinStrip(panel);
    try {
      const body = panel.querySelector('[data-sentry-component="TrackingBody"]');
      const panelRect = panel.getBoundingClientRect();
      const bodyRect = (body || panel).getBoundingClientRect();
      strip.style.top = `${Math.max(0, Math.round(bodyRect.top - panelRect.top))}px`;
    } catch {
      strip.style.top = '60px';
    }
    while (strip.children.length >= SPECIAL_PIN_MAX) strip.lastElementChild.remove();

    const item = document.createElement('div');
    item.className = 'gdh-pin-item';
    const clone = card.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('.gdh-star-button, .gdh-color-button').forEach((n) => n.remove());
    const badge = document.createElement('span');
    badge.className = 'gdh-pin-item__badge';
    badge.textContent = '📌';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-pin-item__close';
    close.textContent = '×';
    item.append(badge, clone, close);

    const href = card.getAttribute('href') || '';
    const dismiss = () => {
      item.remove();
      if (specialPinStrip && !specialPinStrip.children.length) {
        specialPinStrip.remove();
        specialPinStrip = null;
      }
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    item.addEventListener('click', () => {
      dismiss();
      if (card.isConnected) card.click();
      else if (href) window.location.assign(href);
    });
    strip.prepend(item);
    window.setTimeout(dismiss, SPECIAL_PIN_MS);
  }

  function scanPinnedPush() {
    const panel = document.querySelector('[data-sentry-component="WalletTrack"]');
    if (!(panel instanceof HTMLElement)) return;
    const cards = [...panel.querySelectorAll(TRACKER_ITEM_SELECTOR)];
    if (!cards.length) return;

    if (!specialPinBaselineDone) {
      cards.forEach((card) => {
        const address = extractRowWalletAddress(card);
        if (address) rememberPinSeen(trackerCardSignature(card, address));
      });
      specialPinBaselineDone = true;
      return;
    }

    const pinnedActive = hasPinnedWallets();
    cards.forEach((card) => {
      const address = extractRowWalletAddress(card);
      if (!address) return;
      const sig = trackerCardSignature(card, address);
      if (specialPinSeen.has(sig)) return;
      rememberPinSeen(sig);
      if (pinnedActive && specialWalletMap.get(address)?.pin === true) {
        pinTrackerCard(card, panel);
      }
    });
  }

  // ---- 隐藏 frontrun 插件的"闪电交易"按钮 ----
  // 0.15.1：实测按钮宿主是插进 GMGN DOM 的 portal 元素
  // `[data-frontrun-portal="instant-trade"]`（含 tooltip 变体），不是 frontrun-csui。
  // 注意不能碰它的 "cta" portal（战壕行内快速买入按钮）。
  const FRONTRUN_LIGHTNING_SELECTOR =
    '[data-frontrun-portal="instant-trade"], [data-frontrun-portal="instant-trade-tooltip"]';
  // frontrun 在按钮 shadow 里放了 `:host{display:...!important}` 防隐藏加固
  // （shadow 内 important 压过外部 inline important，display:none 无效）；
  // 它没防 visibility 和尺寸——用这组属性把元素视觉+占位全部收干净。
  const FRONTRUN_HIDE_PROPS = [
    ['display', 'none'],
    ['visibility', 'hidden'],
    ['width', '0px'],
    ['height', '0px'],
    ['min-width', '0px'],
    ['min-height', '0px'],
    ['margin', '0px'],
    ['padding', '0px'],
    ['overflow', 'hidden'],
    ['pointer-events', 'none'],
  ];

  function hideFrontrunHost(host) {
    if (host.dataset.gdhHiddenLightning === '1') return;
    host.dataset.gdhHiddenLightning = '1';
    FRONTRUN_HIDE_PROPS.forEach(([prop, value]) => {
      host.style.setProperty(prop, value, 'important');
    });
  }

  function restoreFrontrunHost(host) {
    FRONTRUN_HIDE_PROPS.forEach(([prop]) => host.style.removeProperty(prop));
    delete host.dataset.gdhHiddenLightning;
  }

  // ---- 价格/市值提醒醒目化 ----
  // GMGN 的提醒（价格/市值到价）触发时只弹一条很窄的小 toast（RemindToast.tsx），
  // 极易错过。这里把它接管成画面正中的大卡片，涨绿跌红、带辉光与脉冲。
  const REMIND_TOAST_SELECTOR = '[data-sentry-component="RemindToast"]';
  const REMIND_CARD_MS = 15000;
  const REMIND_CARD_MAX = 3;
  let remindContainer = null;

  function ensureRemindContainer() {
    if (remindContainer && document.contains(remindContainer)) return remindContainer;
    remindContainer = document.createElement('div');
    remindContainer.className = 'gdh-remind-container';
    document.body.appendChild(remindContainer);
    return remindContainer;
  }

  function remindInfoFromToast(node) {
    const link = node.matches('a[href]')
      ? node
      : node.querySelector('a[href]') || node.closest('a[href]');
    const href = link?.getAttribute('href') || '';
    let dir = '';
    if (node.querySelector('.text-increase-100')) dir = 'up';
    else if (node.querySelector('.text-decrease-100')) dir = 'down';

    const texts = [...node.querySelectorAll('*')]
      .filter((el) => el.children.length === 0)
      .map((el) => (el.textContent || '').trim())
      .filter(Boolean);
    const labelIdx = texts.findIndex((t) => /价格|市值|price|mc|market/i.test(t) && t.length <= 8);
    const label = labelIdx >= 0 ? texts[labelIdx] : '';
    const value = labelIdx >= 0
      ? (texts.slice(labelIdx + 1).find((t) => /[\d$]/.test(t)) || '')
      : (texts.find((t) => /^[$≈]/.test(t)) || '');
    const symbol = texts.find((t) => t && t !== label && t !== value && t.length <= 24) || '';
    return { href, dir, label, value, symbol, raw: (node.textContent || '').replace(/\s+/g, ' ').trim() };
  }

  function showRemindCard(info) {
    const container = ensureRemindContainer();
    while (container.children.length >= REMIND_CARD_MAX) container.firstElementChild.remove();

    const card = document.createElement('div');
    card.className = 'gdh-remind-card';
    if (info.dir) card.dataset.gdhDir = info.dir;

    const head = document.createElement('div');
    head.className = 'gdh-remind-card__head';
    const bell = document.createElement('span');
    bell.className = 'gdh-remind-card__bell';
    bell.textContent = info.bell || '🔔';
    const tag = document.createElement('span');
    tag.className = 'gdh-remind-card__tag';
    tag.textContent = info.tagText || (info.dir === 'down' ? '跌破提醒' : '到价提醒');
    head.append(bell, tag);
    if (info.dir) {
      const arrow = document.createElement('span');
      arrow.className = 'gdh-remind-card__arrow';
      arrow.textContent = info.dir === 'down' ? '↓' : '↑';
      head.appendChild(arrow);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-remind-card__close';
    close.textContent = '×';
    close.title = '关闭';
    head.appendChild(close);
    card.appendChild(head);

    const symbolEl = document.createElement('div');
    symbolEl.className = 'gdh-remind-card__symbol';
    symbolEl.textContent = info.symbol || '持仓代币';
    card.appendChild(symbolEl);

    const valueRow = document.createElement('div');
    valueRow.className = 'gdh-remind-card__value';
    if (info.label) {
      const labelEl = document.createElement('span');
      labelEl.className = 'gdh-remind-card__label';
      labelEl.textContent = info.label;
      valueRow.appendChild(labelEl);
    }
    const numEl = document.createElement('strong');
    numEl.className = 'gdh-remind-card__num';
    numEl.textContent = info.value || info.raw.slice(0, 40);
    valueRow.appendChild(numEl);
    card.appendChild(valueRow);

    const foot = document.createElement('div');
    foot.className = 'gdh-remind-card__foot';
    foot.textContent = '点击进入代币页 →';
    card.appendChild(foot);

    let timer = 0;
    const dismiss = () => {
      window.clearTimeout(timer);
      card.remove();
      if (remindContainer && !remindContainer.children.length) {
        remindContainer.remove();
        remindContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(dismiss, REMIND_CARD_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    card.addEventListener('mouseenter', () => window.clearTimeout(timer));
    card.addEventListener('mouseleave', arm);
    card.addEventListener('click', () => {
      dismiss();
      if (info.href) window.location.assign(info.href);
    });
    arm();
    container.appendChild(card);
  }

  // ---- fomo 浮窗：在 GMGN 代币页看该代币在 fomo 的观点/交易 ----
  const FOMO_NETWORK_ID = { bsc: 56, eth: 1, base: 8453, sol: 1399811149 };
  const FOMO_CHAIN_SLUG = { bsc: 'bnb', eth: 'eth', base: 'base', sol: 'sol' };
  const FOMO_REFRESH_MS = 30000;
  let fomoPanelEl = null;
  let fomoTab = 'thesis';
  let fomoLoadedKey = '';
  let fomoTimer = 0;
  let fomoLoading = false;

  function currentTokenRoute() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)/);
    if (!m) return null;
    const chain = m[1];
    if (!(chain in FOMO_NETWORK_ID)) return null;
    return { chain, address: m[2], networkId: FOMO_NETWORK_ID[chain] };
  }

  function fomoAgo(value) {
    const t = Number(new Date(value));
    if (!Number.isFinite(t) || t <= 0) return '';
    return formatRelTime(t);
  }

  function fomoUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    const abs = Math.abs(n);
    const s = abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
      : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K`
        : abs.toFixed(abs >= 10 ? 0 : 2);
    return `${n < 0 ? '-' : ''}$${s}`;
  }

  function pick(obj, keys) {
    for (const k of keys) {
      const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function renderFomoItems(list, items, kind) {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-fomo__empty';
      empty.textContent = kind === 'thesis' ? '还没有人发表观点' : '暂无交易';
      list.appendChild(empty);
      return;
    }
    for (const item of items.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'gdh-fomo__item';

      const head = document.createElement('div');
      head.className = 'gdh-fomo__head';
      const avatarUrl = pick(item, ['user.profilePicture', 'user.profilePicUrl', 'user.avatar', 'profilePicture']);
      if (typeof avatarUrl === 'string' && /^https:\/\//.test(avatarUrl)) {
        const img = document.createElement('img');
        img.className = 'gdh-fomo__avatar';
        img.src = avatarUrl;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        head.appendChild(img);
      }
      const name = document.createElement('strong');
      name.className = 'gdh-fomo__name';
      name.textContent = String(pick(item, ['user.username', 'user.displayName', 'username', 'user.name']) || '匿名');
      head.appendChild(name);

      const pnl = Number(pick(item, ['pnlUsd', 'pnl', 'realizedPnlUsd', 'position.pnlUsd']));
      if (Number.isFinite(pnl) && pnl !== 0) {
        const pnlEl = document.createElement('span');
        pnlEl.className = `gdh-fomo__pnl ${pnl >= 0 ? 'is-up' : 'is-down'}`;
        pnlEl.textContent = fomoUsd(pnl);
        head.appendChild(pnlEl);
      }
      const sizeUsd = Number(pick(item, ['amountUsd', 'usdAmount', 'sizeUsd', 'position.valueUsd']));
      if (Number.isFinite(sizeUsd) && sizeUsd > 0) {
        const sz = document.createElement('span');
        sz.className = 'gdh-fomo__size';
        sz.textContent = fomoUsd(sizeUsd);
        head.appendChild(sz);
      }
      const time = document.createElement('span');
      time.className = 'gdh-fomo__time';
      time.textContent = fomoAgo(pick(item, ['createdAt', 'timestamp', 'createdTime', 'time']));
      head.appendChild(time);
      row.appendChild(head);

      const text = String(pick(item, ['thesis', 'text', 'content', 'body', 'message']) || '').trim();
      if (text) {
        const body = document.createElement('div');
        body.className = 'gdh-fomo__text';
        body.textContent = text;
        row.appendChild(body);
      }
      list.appendChild(row);
    }
  }

  async function loadFomoData(force) {
    const route = currentTokenRoute();
    if (!route || !fomoPanelEl) return;
    const key = `${fomoTab}|${route.chain}|${route.address}`;
    if (!force && key === fomoLoadedKey) return;
    if (fomoLoading) return;
    fomoLoading = true;
    const list = fomoPanelEl.querySelector('.gdh-fomo__list');
    if (key !== fomoLoadedKey) {
      list.replaceChildren();
      const loading = document.createElement('div');
      loading.className = 'gdh-fomo__empty';
      loading.textContent = '加载中…';
      list.appendChild(loading);
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'fomo-token-feed',
        payload: { tokenAddress: route.address, networkId: route.networkId, kind: fomoTab },
      });
      if (!fomoPanelEl) return;
      if (res?.ok) {
        fomoLoadedKey = key;
        renderFomoItems(list, res.items || [], fomoTab);
      } else {
        list.replaceChildren();
        const err = document.createElement('div');
        err.className = 'gdh-fomo__empty';
        if (res?.reason === 'no-token' || res?.reason === 'auth') {
          err.innerHTML = '';
          err.textContent = '需要先登录 fomo：';
          const a = document.createElement('a');
          a.className = 'gdh-fomo__link';
          a.href = 'https://fomo.family/';
          a.target = '_blank';
          a.rel = 'noreferrer';
          a.textContent = '打开 fomo.family 登录一次 →';
          err.appendChild(document.createElement('br'));
          err.appendChild(a);
        } else {
          err.textContent = `加载失败（${res?.reason || 'unknown'}）`;
        }
        list.appendChild(err);
      }
    } catch {
      // 扩展上下文失效
    }
    fomoLoading = false;
  }

  function positionFomoPanel(panel) {
    const pos = settings.fomoPanelPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, pos.x))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, pos.y))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.right = '16px';
      panel.style.top = '110px';
      panel.style.left = 'auto';
    }
  }

  function makeFomoDraggable(panel, handle) {
    let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, a')) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = event.clientX; sy = event.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 120, ox + event.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, oy + event.clientY - sy));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      settings.fomoPanelPos = { x: Math.round(r.left), y: Math.round(r.top) };
      try {
        chrome.storage.local.set({ fomoPanelPos: settings.fomoPanelPos });
      } catch {
        // ignore
      }
    });
  }

  function setFomoOpen(open) {
    settings.fomoPanelOpen = open;
    try {
      chrome.storage.local.set({ fomoPanelOpen: open });
    } catch {
      // ignore
    }
  }

  function buildFomoPanel() {
    const panel = document.createElement('section');
    panel.className = 'gdh-fomo-panel';

    const head = document.createElement('div');
    head.className = 'gdh-fomo__bar';
    const title = document.createElement('strong');
    title.className = 'gdh-fomo__title';
    title.textContent = 'fomo';
    const tabs = document.createElement('div');
    tabs.className = 'gdh-fomo__tabs';
    [['thesis', '观点'], ['swaps', '交易']].forEach(([id, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo__tab';
      btn.dataset.tab = id;
      btn.textContent = label;
      btn.classList.toggle('is-active', fomoTab === id);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        fomoTab = id;
        panel.querySelectorAll('.gdh-fomo__tab').forEach((t) => {
          t.classList.toggle('is-active', t.dataset.tab === id);
        });
        loadFomoData(true);
      });
      tabs.appendChild(btn);
    });
    const open = document.createElement('a');
    open.className = 'gdh-fomo__ext';
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.textContent = '↗';
    open.title = '在 fomo.family 打开';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-fomo__close';
    close.textContent = '×';
    close.title = '收起（点右下角 fomo 按钮再打开）';
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFomoOpen(false);
      scheduleScan();
    });
    head.append(title, tabs, open, close);

    const list = document.createElement('div');
    list.className = 'gdh-fomo__list';
    panel.append(head, list);
    makeFomoDraggable(panel, head);
    return panel;
  }

  function ensureFomoLauncher() {
    let btn = document.querySelector('.gdh-fomo-launcher');
    if (settings.enableFomoPanel === false || !currentTokenRoute()) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gdh-fomo-launcher';
      btn.textContent = 'fomo';
      btn.title = '查看该代币在 fomo 的观点';
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setFomoOpen(!settings.fomoPanelOpen);
        scheduleScan();
      });
      document.body.appendChild(btn);
    }
    btn.classList.toggle('is-active', settings.fomoPanelOpen === true);
  }

  function scanFomoPanel() {
    const route = currentTokenRoute();
    if (settings.enableFomoPanel === false || !route || settings.fomoPanelOpen !== true) {
      if (fomoPanelEl) {
        fomoPanelEl.remove();
        fomoPanelEl = null;
        fomoLoadedKey = '';
      }
      if (fomoTimer) {
        window.clearInterval(fomoTimer);
        fomoTimer = 0;
      }
      ensureFomoLauncher();
      return;
    }
    ensureFomoLauncher();
    if (!fomoPanelEl || !document.contains(fomoPanelEl)) {
      fomoPanelEl = buildFomoPanel();
      document.body.appendChild(fomoPanelEl);
      positionFomoPanel(fomoPanelEl);
      fomoLoadedKey = '';
    }
    const slug = FOMO_CHAIN_SLUG[route.chain] || route.chain;
    const ext = fomoPanelEl.querySelector('.gdh-fomo__ext');
    if (ext) ext.href = `https://fomo.family/tokens/${slug}/${route.address}`;
    loadFomoData(false);
    if (!fomoTimer) {
      fomoTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') loadFomoData(true);
      }, FOMO_REFRESH_MS);
    }
  }

  // ---- 持仓暴涨提醒 ----
  // 清单：持仓面板开着时从行上读 {chain,address,symbol} 缓存下来（面板只显示当前链，
  // 切链再开一次就把那条链也收进来），之后面板关掉也在。
  // 行情：走公开的 mutil_window_token_info（免登录，返回 price 与 price_1m/5m），
  // 全程不碰任何登录凭据。
  const HOLDING_ROW_SELECTOR = '[data-sentry-component="SmToken"]';
  const HOLDING_WATCH_MAX = 80;
  const HOLDING_POLL_MS = 30000;
  const HOLDING_COOLDOWN_MS = 60 * 60 * 1000;
  const HOLDING_BATCH = 40;
  const holdingAlertedAt = new Map();
  let holdingWatchMap = new Map();
  let holdingSaveTimer = 0;
  let holdingPollTimer = 0;
  let holdingPolling = false;

  function rebuildHoldingWatch() {
    holdingWatchMap = new Map(
      (Array.isArray(settings.holdingWatchList) ? settings.holdingWatchList : [])
        .filter((item) => item && item.chain && item.address)
        .map((item) => [
          `${item.chain}:${item.address}`,
          {
            chain: String(item.chain),
            address: String(item.address),
            symbol: String(item.symbol || ''),
            at: Number(item.at) || 0,
          },
        ]),
    );
  }

  function scheduleHoldingSave() {
    if (holdingSaveTimer) return;
    holdingSaveTimer = window.setTimeout(() => {
      holdingSaveTimer = 0;
      const list = [...holdingWatchMap.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, HOLDING_WATCH_MAX);
      settings.holdingWatchList = list;
      try {
        chrome.storage.local.set({ holdingWatchList: list });
      } catch {
        // context invalidated
      }
    }, 800);
  }

  /** 从持仓面板行收集当前链的持仓，合并进缓存清单。 */
  function collectHoldingRows() {
    let changed = false;
    document.querySelectorAll(HOLDING_ROW_SELECTOR).forEach((row) => {
      const chain = row.getAttribute('data-gdh-hold-chain') || '';
      const address = row.getAttribute('data-gdh-hold-addr') || '';
      if (!chain || !address) return;
      const symbol = row.getAttribute('data-gdh-hold-symbol') || '';
      const key = `${chain}:${address}`;
      const prev = holdingWatchMap.get(key);
      if (!prev || prev.symbol !== symbol) changed = true;
      holdingWatchMap.set(key, { chain, address, symbol, at: Date.now() });
    });
    if (changed) scheduleHoldingSave();
  }

  function formatPriceShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${n.toPrecision(4)}`;
  }

  async function pollHoldingSurge() {
    if (holdingPolling) return;
    if (settings.enableHoldingSurge === false) return;
    if (!isTabVisibleForHolding()) return;
    const entries = [...holdingWatchMap.values()];
    if (!entries.length) return;

    holdingPolling = true;
    const threshold = Math.max(5, Number(settings.holdingSurgeThreshold) || 20);
    const byChain = new Map();
    entries.forEach((item) => {
      if (!byChain.has(item.chain)) byChain.set(item.chain, []);
      byChain.get(item.chain).push(item);
    });

    for (const [chain, items] of byChain) {
      for (let i = 0; i < items.length; i += HOLDING_BATCH) {
        const slice = items.slice(i, i + HOLDING_BATCH);
        try {
          const res = await fetch(`https://gmgn.ai/api/v1/mutil_window_token_info?${DEV_ATH_QS}`, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chain, addresses: slice.map((s) => s.address) }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.code !== 0 || !Array.isArray(body.data)) continue;
          body.data.forEach((token) => {
            const p = token?.price;
            if (!p) return;
            const now = Number(p.price);
            const past = Number(p.price_5m);
            if (!Number.isFinite(now) || !Number.isFinite(past) || past <= 0) return;
            const pct = ((now - past) / past) * 100;
            if (pct < threshold) return;
            const address = String(token.address || p.address || '');
            const key = `${chain}:${address}`;
            const last = holdingAlertedAt.get(key) || 0;
            if (Date.now() - last < HOLDING_COOLDOWN_MS) return;
            holdingAlertedAt.set(key, Date.now());
            const meta = holdingWatchMap.get(key);
            showRemindCard({
              href: `/${chain}/token/${address}`,
              dir: 'up',
              bell: '🚀',
              tagText: '持仓暴涨',
              symbol: meta?.symbol || token.symbol || '持仓代币',
              label: '5分钟',
              value: `+${pct.toFixed(0)}%  ${formatPriceShort(now)}`,
              raw: '',
            });
          });
        } catch {
          // 网络失败静默跳过，下轮再试
        }
      }
    }
    holdingPolling = false;
  }

  function isTabVisibleForHolding() {
    return document.visibilityState === 'visible';
  }

  function startHoldingPoll() {
    if (holdingPollTimer) return;
    holdingPollTimer = window.setInterval(() => {
      pollHoldingSurge().catch(() => {});
    }, HOLDING_POLL_MS);
  }

  function scanHoldingSurge() {
    if (settings.enableHoldingSurge === false) {
      if (holdingPollTimer) {
        window.clearInterval(holdingPollTimer);
        holdingPollTimer = 0;
      }
      return;
    }
    collectHoldingRows();
    startHoldingPoll();
  }

  function scanRemindToasts() {
    if (settings.enableRemindAlert === false) {
      document.querySelectorAll('[data-gdh-remind-taken="1"]').forEach((node) => {
        node.style.removeProperty('display');
        delete node.dataset.gdhRemindTaken;
      });
      remindContainer?.remove();
      remindContainer = null;
      return;
    }
    document.querySelectorAll(REMIND_TOAST_SELECTOR).forEach((node) => {
      if (node.dataset.gdhRemindTaken === '1') return;
      node.dataset.gdhRemindTaken = '1';
      try {
        showRemindCard(remindInfoFromToast(node));
        // 原生小 toast 收起，避免同一条提醒重复出现两次。
        node.style.setProperty('display', 'none', 'important');
      } catch {
        node.style.removeProperty('display');
      }
    });
  }

  function scanFrontrunLightning() {
    if (settings.hideLightningTrade !== true) {
      document
        .querySelectorAll('[data-gdh-hidden-lightning="1"]')
        .forEach(restoreFrontrunHost);
      return;
    }
    document.querySelectorAll(FRONTRUN_LIGHTNING_SELECTOR).forEach(hideFrontrunHost);
    // 兼容旧识别路径：frontrun-csui 容器内文案含"闪电交易"的一并隐藏。
    document.querySelectorAll('frontrun-csui').forEach((host) => {
      try {
        const shadow = host.shadowRoot;
        if (!shadow) return;
        const isLightning = (shadow.textContent || '').includes('闪电交易');
        if (isLightning) hideFrontrunHost(host);
        else if (host.dataset.gdhHiddenLightning === '1') restoreFrontrunHost(host);
      } catch {
        // 第三方结构变化时静默跳过
      }
    });
  }

  // ---- 新宣言弹窗提醒 ----
  const MANI_SEEN_MAX = 500;
  const MANI_SEEN_STORE_KEY = 'maniSeenKeys';
  const MANI_TOAST_MS = 12000;
  const MANI_TOAST_MAX = 3;
  const MANI_BASELINE_FAILSAFE_MS = 8000;
  const maniSeen = new Set();
  let maniSeenLoaded = false;
  let maniSeenSaveTimer = 0;
  let maniBaselineDone = false;
  let maniRailFirstSeenAt = 0;
  let maniContainer = null;

  function maniKeyFromChip(chip) {
    const ulid = chip.dataset.gdhManiUlid || '';
    if (ulid) return ulid;
    const href = chip.getAttribute('href') || '';
    const token = normalizeAddress(
      chip.dataset.gdhManiToken || (href.match(/\/token\/(0x[a-fA-F0-9]{40})/) || [])[1] || '',
    );
    if (!token) return '';
    return `${token}|${chip.dataset.gdhCallerHandle || ''}`;
  }

  function trimManiSeen() {
    if (maniSeen.size <= MANI_SEEN_MAX) return;
    const iterator = maniSeen.values();
    for (let extra = maniSeen.size - MANI_SEEN_MAX; extra > 0; extra -= 1) {
      maniSeen.delete(iterator.next().value);
    }
  }

  // 已见宣言持久化：新页面/新标签页不再把旧宣言当新宣言重复弹。
  function scheduleManiSeenSave() {
    if (maniSeenSaveTimer) return;
    maniSeenSaveTimer = window.setTimeout(() => {
      maniSeenSaveTimer = 0;
      try {
        chrome.storage.local.set({ [MANI_SEEN_STORE_KEY]: [...maniSeen] });
      } catch {
        // context invalidated — 忽略
      }
    }, 400);
  }

  // 合并其他标签页写入的已见集合；不回写，避免多标签互相触发循环。
  function mergeManiSeenKeys(keys) {
    if (!Array.isArray(keys)) return;
    keys.forEach((key) => {
      if (typeof key === 'string' && key) maniSeen.add(key);
    });
    trimManiSeen();
  }

  function rememberManiKey(key) {
    maniSeen.add(key);
    trimManiSeen();
    scheduleManiSeenSave();
  }

  function manifestoTokenHref(chip) {
    const href = chip.getAttribute('href') || '';
    if (/\/token\/0x[a-fA-F0-9]{40}/.test(href)) return href;
    const token = normalizeAddress(chip.dataset.gdhManiToken);
    return token ? `/bsc/token/${token}` : '';
  }

  function ensureManiContainer() {
    if (maniContainer && document.contains(maniContainer)) return maniContainer;
    maniContainer = document.createElement('div');
    maniContainer.className = 'gdh-mani-toast-container';
    document.body.appendChild(maniContainer);
    return maniContainer;
  }

  /**
   * 0.13.0：宣言卡片统一渲染（居中弹窗 + 宣言列表共用），样式对齐 GMGN
   * 官方宣言悬浮卡：头像 / 名字 / 认证√ / 倍数 / 时间 / 正文 / 代币行。
   */
  function buildManiCard(info) {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'gdh-mani-card__head';
    if (info.avatar) {
      const avatar = document.createElement('img');
      avatar.className = 'gdh-mani-card__avatar';
      avatar.src = info.avatar;
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
      head.appendChild(avatar);
    }
    const main = document.createElement('div');
    main.className = 'gdh-mani-card__main';
    const nameRow = document.createElement('div');
    nameRow.className = 'gdh-mani-card__namerow';
    const nameEl = document.createElement('strong');
    nameEl.className = 'gdh-mani-card__name';
    nameEl.textContent = info.name || info.handle || '匿名';
    nameRow.appendChild(nameEl);
    if (info.verified) {
      const check = document.createElement('span');
      check.className = 'gdh-mani-card__verified';
      check.textContent = '✔';
      check.setAttribute('aria-label', '认证');
      nameRow.appendChild(check);
    }
    const mult = Number(info.multiplier);
    if (Number.isFinite(mult) && mult > 0) {
      const multEl = document.createElement('span');
      multEl.className = 'gdh-mani-card__mult';
      multEl.textContent = `${mult.toFixed(1).replace(/\.0$/, '')}x`;
      nameRow.appendChild(multEl);
    }
    main.appendChild(nameRow);
    if (info.handle) {
      const handleEl = document.createElement('div');
      handleEl.className = 'gdh-mani-card__handle';
      handleEl.textContent = `@${info.handle}`;
      main.appendChild(handleEl);
    }
    head.appendChild(main);
    const timeMs = Number(info.timeMs);
    if (Number.isFinite(timeMs) && timeMs > 0) {
      const timeEl = document.createElement('span');
      timeEl.className = 'gdh-mani-card__time';
      timeEl.textContent = formatRelTime(timeMs);
      head.appendChild(timeEl);
    }
    frag.appendChild(head);

    if (info.text) {
      const textEl = document.createElement('div');
      textEl.className = 'gdh-mani-card__text';
      textEl.textContent = info.text;
      frag.appendChild(textEl);
    }

    const foot = document.createElement('div');
    foot.className = 'gdh-mani-card__foot';
    const symbolEl = document.createElement('strong');
    symbolEl.className = 'gdh-mani-card__symbol';
    symbolEl.textContent = info.symbol || '代币';
    foot.appendChild(symbolEl);
    if (info.usd) {
      const usdEl = document.createElement('span');
      usdEl.className = 'gdh-mani-card__usd';
      usdEl.textContent = `$${info.usd}`;
      foot.appendChild(usdEl);
    }
    const hint = document.createElement('span');
    hint.className = 'gdh-mani-card__hint';
    hint.textContent = '点击进入代币页 →';
    foot.appendChild(hint);
    frag.appendChild(foot);

    return frag;
  }

  function maniInfoFromChip(chip) {
    return {
      avatar: chip.dataset.gdhManiAvatar || '',
      name: chip.dataset.gdhCallerName || '',
      handle: chip.dataset.gdhCallerHandle || '',
      verified: chip.dataset.gdhManiVerified === '1',
      multiplier: chip.dataset.gdhManiMult || '',
      timeMs: chip.dataset.gdhManiTime || '',
      text: chip.dataset.gdhManiText || '',
      symbol: chip.dataset.gdhManiSymbol || '',
      usd: chip.dataset.gdhManiUsd || '',
    };
  }

  function showManifestoToast(chip) {
    const href = manifestoTokenHref(chip);
    if (!href) return;

    const container = ensureManiContainer();
    while (container.children.length >= MANI_TOAST_MAX) {
      container.firstElementChild.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'gdh-mani-toast';
    toast.appendChild(buildManiCard(maniInfoFromChip(chip)));

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gdh-mani-toast__close';
    close.textContent = '×';
    close.title = '关闭';
    toast.appendChild(close);

    let dismissTimer = 0;
    const dismiss = () => {
      window.clearTimeout(dismissTimer);
      toast.remove();
      if (maniContainer && !maniContainer.children.length) {
        maniContainer.remove();
        maniContainer = null;
      }
    };
    const arm = () => {
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(dismiss, MANI_TOAST_MS);
    };
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    toast.addEventListener('mouseenter', () => window.clearTimeout(dismissTimer));
    toast.addEventListener('mouseleave', arm);
    toast.addEventListener('click', () => {
      dismiss();
      // 原 chip 还在就代理点击（走 GMGN 自己的 SPA 路由），否则整页跳转。
      if (chip.isConnected) chip.click();
      else window.location.assign(href);
    });
    arm();
    container.appendChild(toast);
  }

  // ---- 喊单窗"宣言"标签页：按时间倒序列出当前宣言 ----
  const MANI_LIST_REFRESH_MS = 30000;
  const MANI_LIST_STALE_MS = 15000;
  let maniListOpen = false;
  let maniListTimer = 0;
  let maniListLoading = false;
  let maniListCache = { at: 0, list: [] };

  function formatRelTime(ms) {
    const diff = Math.max(0, Date.now() - Number(ms));
    if (diff < 60e3) return `${Math.max(1, Math.floor(diff / 1e3))}秒前`;
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}小时前`;
    return `${Math.floor(diff / 86400e3)}天前`;
  }

  async function fetchManifestoSnapshot() {
    if (maniListLoading) return;
    maniListLoading = true;
    try {
      const res = await fetch(
        `https://gmgn.ai/api/v1/notification/callout/declaration/global_snapshot?${DEV_ATH_QS}&chains=bsc`,
        { credentials: 'include' },
      );
      const body = await res.json().catch(() => null);
      if (res.ok && body?.code === 0 && Array.isArray(body.data?.list)) {
        maniListCache = { at: Date.now(), list: body.data.list };
      }
    } catch {
      // 网络失败保留旧缓存
    }
    maniListLoading = false;
    if (maniListOpen) scheduleScan();
  }

  function stopManiListTimer() {
    if (maniListTimer) {
      window.clearInterval(maniListTimer);
      maniListTimer = 0;
    }
  }

  function manifestoItemBlocked(item) {
    return isCallerBlocked({
      wallet: normalizeAddress(item.call_wallet),
      handle: normalizeHandle(item.twitter_username),
    });
  }

  function renderManifestoListModal(modal) {
    const items = [...maniListCache.list]
      .filter((item) => !manifestoItemBlocked(item))
      .sort((a, b) => Number(b.create_time) - Number(a.create_time));
    const key = `${maniListCache.at}|${items.map((it) => it.ulid || it.id).join(',')}|${Math.floor(Date.now() / MANI_LIST_REFRESH_MS)}`;
    if (modal.dataset.gdhManiListKey === key) return;
    modal.dataset.gdhManiListKey = key;

    const list = modal.querySelector('.gdh-mani-list__items');
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'gdh-mani-list__empty';
      empty.textContent = maniListCache.at ? '当前没有宣言' : '加载中…';
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      const token = normalizeAddress(item.call_token);
      if (!token) continue;
      const row = document.createElement('a');
      row.className = 'gdh-mani-list__item';
      row.href = `/bsc/token/${token}`;
      row.appendChild(buildManiCard({
        avatar: /^https:\/\//.test(String(item.wallet_avatar || '')) ? item.wallet_avatar : '',
        name: String(item.twitter_name || '').trim(),
        handle: String(item.twitter_username || '').trim(),
        verified: String(item.is_blue_verified) === 'true',
        multiplier: item.multiplier,
        timeMs: item.create_time,
        text: String(item.call_thesis?.source_content || '').trim(),
        symbol: String(item.token_symbol || '代币').slice(0, 24),
        usd: item.amount_usd || '',
      }));

      row.addEventListener('click', (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        scheduleScan();
        // 宣言栏里同 ulid 的 chip 还在就代理点击（SPA 路由），否则整页跳转。
        const chip = item.ulid
          ? document.querySelector(`${MANIFESTO_SELECTOR}[data-gdh-mani-ulid="${item.ulid}"]`)
          : null;
        if (chip instanceof HTMLElement && chip.isConnected) chip.click();
        else window.location.assign(`/bsc/token/${token}`);
      });
      list.appendChild(row);
    }
  }

  function ensureManifestoListModal(context) {
    let modal = context.panel.querySelector(':scope > .gdh-mani-list-modal');
    if (!maniListOpen) {
      modal?.remove();
      stopManiListTimer();
      return;
    }

    context.panel.classList.add('gdh-callout-panel-host');
    if (!modal) {
      modal = document.createElement('section');
      modal.className = 'gdh-mani-list-modal';
      modal.addEventListener('pointerdown', (event) => event.stopPropagation());

      const header = document.createElement('div');
      header.className = 'gdh-mani-list__header';
      const title = document.createElement('strong');
      title.textContent = '当前宣言 · 按时间';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'gdh-mani-list__close';
      close.textContent = '×';
      close.title = '关闭宣言列表';
      close.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = false;
        modal.remove();
        stopManiListTimer();
        scheduleScan();
      });
      header.append(title, close);

      const list = document.createElement('div');
      list.className = 'gdh-mani-list__items';
      modal.append(header, list);
      context.panel.appendChild(modal);
    }

    // 挂在 GMGN tab 行下方，保留 tab 行可点（点官方 tab 会关掉本列表）。
    try {
      const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
      const rowRect = (firstTab?.parentElement || context.header).getBoundingClientRect();
      const panelRect = context.panel.getBoundingClientRect();
      const top = Math.max(40, Math.round(rowRect.bottom - panelRect.top) + 6);
      modal.style.top = `${top}px`;
    } catch {
      modal.style.top = '76px';
    }

    if (Date.now() - maniListCache.at > MANI_LIST_STALE_MS) fetchManifestoSnapshot();
    if (!maniListTimer) {
      maniListTimer = window.setInterval(fetchManifestoSnapshot, MANI_LIST_REFRESH_MS);
    }
    renderManifestoListModal(modal);
  }

  function ensureManifestoTab() {
    if (settings.enableManifestoTab === false) {
      document
        .querySelectorAll('.gdh-mani-tab-button, .gdh-mani-list-modal')
        .forEach((node) => node.remove());
      maniListOpen = false;
      stopManiListTimer();
      return;
    }
    const context = getCalloutPanelContext();
    if (!context) {
      if (maniListOpen) {
        maniListOpen = false;
        stopManiListTimer();
      }
      return;
    }
    const firstTab = context.panel.querySelector('button[data-sentry-component="renderTab"]');
    const tabsInner = firstTab?.parentElement;
    if (!(tabsInner instanceof HTMLElement)) return;

    let button = tabsInner.querySelector(':scope > .gdh-mani-tab-button');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'gdh-mani-tab-button';
      button.title = '按时间查看当前宣言';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        maniListOpen = !maniListOpen;
        if (maniListOpen) blacklistModalOpen = false;
        scheduleScan();
      });
      tabsInner.appendChild(button);
      if (!tabsInner.dataset.gdhManiTabWatch) {
        tabsInner.dataset.gdhManiTabWatch = '1';
        tabsInner.addEventListener(
          'click',
          (event) => {
            if (!maniListOpen) return;
            if (event.target.closest?.('button[data-sentry-component="renderTab"]')) {
              maniListOpen = false;
              scheduleScan();
            }
          },
          true,
        );
      }
    }
    const visible = maniListCache.list.filter((item) => !manifestoItemBlocked(item)).length;
    const label = maniListCache.at && visible ? `宣言 ${visible}` : '宣言';
    if (button.textContent !== label) button.textContent = label;
    button.classList.toggle('is-active', maniListOpen);
    ensureManifestoListModal(context);
  }

  function scanManifestoToasts() {
    if (settings.enableManifestoToast === false) {
      maniContainer?.remove();
      maniContainer = null;
      return;
    }
    if (!maniSeenLoaded) return;
    const chips = [...document.querySelectorAll(MANIFESTO_SELECTOR)];
    const railExists = chips.length > 0
      || !!document.querySelector('[data-sentry-component="ManifestoRailInner"]');
    if (!railExists) return;

    if (!maniBaselineDone) {
      if (!maniRailFirstSeenAt) maniRailFirstSeenAt = Date.now();
      // 0.10.1: 空栏不算基线——GMGN 先挂空容器、快照晚到，过早提交会把
      // 旧宣言全判成新宣言（新开页面重复弹）。等到有完整可识别的宣言才提交；
      // 真·无宣言的页面走 8s 兜底。
      const failsafeElapsed =
        Date.now() - maniRailFirstSeenAt >= MANI_BASELINE_FAILSAFE_MS;
      const snapshotReady =
        chips.length > 0 && chips.every((chip) => maniKeyFromChip(chip));
      if (!snapshotReady && !failsafeElapsed) return;
      chips.forEach((chip) => {
        const key = maniKeyFromChip(chip);
        if (key) rememberManiKey(key);
      });
      maniBaselineDone = true;
      return;
    }

    chips.forEach((chip) => {
      const key = maniKeyFromChip(chip);
      if (!key || maniSeen.has(key)) return;
      rememberManiKey(key);
      if (isCallerBlocked(getCallerFromElement(chip))) return;
      showManifestoToast(chip);
    });
  }

  function scanCalloutBlacklist() {
    if (settings.enableCalloutBlacklist === false) {
      blacklistModalOpen = false;
      document.querySelectorAll('.gdh-callout-blacklist-button, .gdh-callout-block-button, .gdh-callout-blacklist-modal, .gdh-callout-toast')
        .forEach((element) => element.remove());
      document.querySelectorAll('[data-gdh-callout-host="1"]').forEach((host) => {
        delete host.dataset.gdhCalloutHost;
        delete host.dataset.gdhCallerBlocked;
      });
      document.querySelectorAll(`${MANIFESTO_SELECTOR}[data-gdh-caller-blocked="1"]`)
        .forEach((chip) => delete chip.dataset.gdhCallerBlocked);
      document.querySelectorAll('.gdh-callout-panel-host')
        .forEach((panel) => panel.classList.remove('gdh-callout-panel-host'));
      return;
    }

    document.querySelectorAll(CALLOUT_SELECTOR).forEach(applyCalloutCardState);
    document.querySelectorAll(MANIFESTO_SELECTOR).forEach(applyManifestoState);
    ensureCalloutControls();
  }

  function scanCards() {
    scanScheduled = false;
    if (settings.showDevTooltip === false) {
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    }
    document.documentElement.style.setProperty(
      '--gdh-highlight',
      settings.highlightColor || DEFAULTS.highlightColor,
    );
    scanVisibleCards();
    ensureDeveloperBookmarkButtons();
  }

  function scanVisibleCards() {
    document.querySelectorAll(CARD_SELECTOR).forEach(applyCardState);
    scanCalloutBlacklist();
    scanManifestoToasts();
    ensureManifestoTab();
    scanSpecialWallets();
    scanFrontrunLightning();
    scanRemindToasts();
    scanHoldingSurge();
    scanFomoPanel();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    window.setTimeout(scanCards, 0);
  }

  function scheduleScrollScan(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-sentry-component="PumpSubX"]')) {
      return;
    }

    window.clearTimeout(scrollScanTimer);
    scrollScanTimer = window.setTimeout(() => {
      scrollScanTimer = 0;
      scheduleScan();
    }, 100);
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;

    tooltip = document.createElement('div');
    tooltip.className = 'gdh-tooltip';
    tooltip.setAttribute('role', 'tooltip');

    const title = document.createElement('div');
    title.className = 'gdh-tooltip__title';
    title.dataset.field = 'title';
    tooltip.appendChild(title);

    const address = document.createElement('div');
    address.className = 'gdh-tooltip__address';
    address.dataset.field = 'address';
    tooltip.appendChild(address);

    const fields = [
      ['Dev 发币迁移数', 'migrated'],
      ['Dev 发币总数', 'total'],
      ['Dev 发币迁移比例', 'ratio'],
    ];
    for (const [labelText, field] of fields) {
      const row = document.createElement('div');
      row.className = 'gdh-tooltip__row';
      const label = document.createElement('span');
      label.textContent = labelText;
      const value = document.createElement('strong');
      value.dataset.field = field;
      row.append(label, value);
      tooltip.appendChild(row);
    }

    document.body.appendChild(tooltip);
    return tooltip;
  }

  function setTooltipField(field, value) {
    ensureTooltip().querySelector(`[data-field="${field}"]`).textContent = value;
  }

  function fillTooltip(card) {
    const label = card.dataset.gdhWatchLabel;
    const symbol = card.dataset.gdhSymbol;
    setTooltipField('title', label || symbol || '重点 Dev');
    setTooltipField('address', card.dataset.gdhCreator || '--');
    setTooltipField('migrated', formatCount(card.dataset.gdhMigrated));
    setTooltipField('total', formatCount(card.dataset.gdhTotal));
    setTooltipField('ratio', formatRatio(card));
  }

  function positionTooltip(event) {
    if (!tooltip || !tooltip.classList.contains('gdh-tooltip--visible')) return;
    const gap = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + rect.width + 10 > window.innerWidth) left = event.clientX - rect.width - gap;
    if (top + rect.height + 10 > window.innerHeight) top = event.clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function findWatchedCard(target) {
    if (settings.showDevTooltip === false || !(target instanceof Element)) return null;
    return target.closest(`${CARD_SELECTOR}[data-gdh-watched="1"]`);
  }

  document.addEventListener(
    'pointerover',
    (event) => {
      const card = findWatchedCard(event.target);
      if (!card || card === activeCard) return;
      activeCard = card;
      fillTooltip(card);
      ensureTooltip().classList.add('gdh-tooltip--visible');
      positionTooltip(event);
    },
    true,
  );

  document.addEventListener(
    'pointerout',
    (event) => {
      if (!activeCard) return;
      if (event.relatedTarget instanceof Node && activeCard.contains(event.relatedTarget)) return;
      const leavingCard = findWatchedCard(event.target);
      if (leavingCard !== activeCard) return;
      activeCard = null;
      tooltip?.classList.remove('gdh-tooltip--visible');
    },
    true,
  );

  document.addEventListener('pointermove', positionTooltip, true);
  document.addEventListener('scroll', scheduleScrollScan, true);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'data-gdh-creator',
      'data-gdh-migrated',
      'data-gdh-total',
      'data-gdh-ratio',
      'data-gdh-symbol',
      'data-gdh-ready',
      'data-gdh-caller-ready',
      'data-gdh-caller-wallet',
      'data-gdh-caller-handle',
      'data-gdh-caller-name',
      'href',
    ],
  });

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  chrome.storage.local.get({ [MANI_SEEN_STORE_KEY]: [] }, (stored) => {
    mergeManiSeenKeys(stored[MANI_SEEN_STORE_KEY]);
    maniSeenLoaded = true;
    scheduleScan();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key === MANI_SEEN_STORE_KEY) {
        mergeManiSeenKeys(change.newValue);
        continue;
      }
      settings[key] = change.newValue;
    }
    rebuildWatchedMap();
    rebuildBlockedCallerIndex();
    rebuildSpecialWalletSet();
    rebuildHoldingWatch();
    scheduleScan();
  });

  window.setInterval(scanVisibleCards, 1000);
})();
